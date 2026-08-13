import { describe, test } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runRealRepoRunAICandidateFlow } from '../src/real-repo-run-ai-candidate.js';
import { saveCandidateSnapshot } from '../src/candidate-state.js';
import { saveState, initState } from '../src/state-manager.js';
import type { Task, RunState } from '../src/types.js';

function git(args: string[], cwd: string): { status: number; stdout: string; stderr: string } {
  const result = spawnSync('git', args, { cwd, encoding: 'utf-8', shell: false });
  return {
    status: result.status ?? 1,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  };
}

function makeTempRepo(name: string): { path: string; baseSha: string; remotePath: string } {
  const root = join(tmpdir(), `resume-test-${Date.now()}-${name}`);
  const repoPath = join(root, 'repo');
  const remotePath = join(root, 'remote.git');
  mkdirSync(repoPath, { recursive: true });
  mkdirSync(remotePath, { recursive: true });

  git(['init', '--bare'], remotePath);

  git(['init'], repoPath);
  git(['config', 'user.email', 'test@example.com'], repoPath);
  git(['config', 'user.name', 'Test'], repoPath);
  writeFileSync(join(repoPath, 'README.md'), '# base\n', 'utf-8');
  git(['add', 'README.md'], repoPath);
  git(['commit', '-m', 'base'], repoPath);
  git(['remote', 'add', 'origin', remotePath], repoPath);
  git(['push', 'origin', 'HEAD:main'], repoPath);

  const rev = git(['rev-parse', 'HEAD'], repoPath);
  if (rev.status !== 0) throw new Error('Failed to read base sha');
  const baseSha = rev.stdout.trim();
  git(['checkout', '-b', 'mission-resume', baseSha], repoPath);
  git(['push', 'origin', 'HEAD:mission-resume'], repoPath);
  git(['checkout', 'main'], repoPath);

  return { path: repoPath, baseSha, remotePath };
}

const acceptedReviewerResponse = JSON.stringify({
  decision: 'accepted',
  confidence: 'high',
  blocking_issues: [],
  non_blocking_issues: [],
  review_summary: 'Looks good',
  fix_task: null,
  next_action: 'advance_to_next_task',
});

describe('real-repo-run-ai candidate resume', () => {
  test('resuming from reviewer_pending does not re-run coder', async () => {
    const repo = makeTempRepo('a');
    const taskId = 'resume-task';
    const workBranch = 'mission-resume';
    const runsDir = join(tmpdir(), `resume-runs-${Date.now()}`);
    mkdirSync(runsDir, { recursive: true });

    const task: Task = {
      id: taskId,
      title: 'Resume task',
      repo_path: repo.path,
      base_branch: 'main',
      work_branch: workBranch,
      goal: 'Add docs/resume.md',
      context_files: [],
      checks: [],
      guardrails: {
        allow_modify: ['docs/resume.md'],
        deny_modify: ['.env'],
        auto_commit: true,
        auto_push: true,
      },
    };

    const candidatePath = join(tmpdir(), `resume-candidate-${Date.now()}`);
    mkdirSync(candidatePath, { recursive: true });

    // Bootstrap candidate workspace from base.
    const clone = spawnSync('git', ['clone', '--config', 'core.autocrlf=false', '--no-checkout', repo.path, candidatePath], {
      encoding: 'utf-8',
      shell: false,
    });
    if (clone.status !== 0) throw new Error(`clone failed: ${clone.stderr}`);
    git(['config', 'user.email', 'test@example.com'], candidatePath);
    git(['config', 'user.name', 'Test'], candidatePath);
    git(['checkout', '-b', `candidate/${taskId}`, repo.baseSha], candidatePath);

    const changedFile = 'docs/resume.md';
    const content = '# Resume\n';
    mkdirSync(join(candidatePath, 'docs'), { recursive: true });
    writeFileSync(join(candidatePath, changedFile), content, 'utf-8');
    git(['add', changedFile], candidatePath);

    // Save snapshot so resume can restore if workspace is validated.
    saveCandidateSnapshot(runsDir, taskId, {
      attemptId: 'checking-test',
      phase: 'checking',
      taskBaseSha: repo.baseSha,
      changedFiles: [changedFile],
      fileContents: [{ path: changedFile, content, sha256: '' }],
      candidatePackageHash: '',
    });

    // Pre-create state as if the task was killed in reviewer_pending.
    const state: RunState = {
      ...initState(task),
      task_base_sha: repo.baseSha,
      candidate_path: candidatePath,
      task_phase: 'reviewer_pending',
      expected_changed_files: [changedFile],
      total_elapsed_ms: 5000,
      continuation_count: 1,
    };
    saveState(taskId, state, join(runsDir, 'tasks'));

    const prevKimiFake = process.env.KIMI_FAKE_RESPONSE;
    const prevReviewerFake = process.env.REAL_REPO_REVIEWER_FAKE_RESPONSE;
    process.env.KIMI_FAKE_RESPONSE = JSON.stringify({
      mode: 'file_update',
      files: [{ path: 'docs/resume.md', content: '# should not run\n' }],
      notes: 'coder fake',
    });
    process.env.REAL_REPO_REVIEWER_FAKE_RESPONSE = acceptedReviewerResponse;

    try {
      const result = await runRealRepoRunAICandidateFlow({
        task,
        taskBaseSha: repo.baseSha,
        candidatePath,
        runId: 'resume-run',
        isResume: true,
        resumeTimeoutMs: 600000,
        maxAttempts: 2,
        reviewerMaxFixAttempts: 1,
        reviewerParseRetries: 2,
        apiKey: 'sk-test',
        baseUrl: 'https://api.example.com',
        model: 'kimi-k2.6',
        fetchFn: async () => {
          throw new Error('unexpected fetch');
        },
        runsDir: join(runsDir, 'tasks'),
      });

      const attempts = result.state.provider_attempts ?? [];
      const coderAttempts = attempts.filter((a) => a.type === 'initial_coder');
      const reviewerAttempts = attempts.filter((a) => a.type === 'reviewer');
      assert.strictEqual(coderAttempts.length, 0, `Expected no coder attempts, got ${JSON.stringify(attempts)}`);
      assert.strictEqual(reviewerAttempts.length, 1);
      assert.strictEqual(reviewerAttempts[0].ok, true);
      assert.strictEqual(result.state.task_phase, 'pushed');
      assert.strictEqual(result.exitCode, 0);
    } finally {
      if (prevKimiFake !== undefined) process.env.KIMI_FAKE_RESPONSE = prevKimiFake;
      else delete process.env.KIMI_FAKE_RESPONSE;
      if (prevReviewerFake !== undefined) process.env.REAL_REPO_REVIEWER_FAKE_RESPONSE = prevReviewerFake;
      else delete process.env.REAL_REPO_REVIEWER_FAKE_RESPONSE;
      rmSync(runsDir, { recursive: true, force: true });
      rmSync(candidatePath, { recursive: true, force: true });
      rmSync(repo.path, { recursive: true, force: true });
      rmSync(repo.remotePath, { recursive: true, force: true });
    }
  });
});

import { describe, test } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { initState, saveState, getRunDir } from '../src/state-manager.js';
import { loadTask } from '../src/task-loader.js';
import { saveCandidateSnapshot, computeFileHash, type CandidateSnapshot } from '../src/candidate-state.js';
import { createCandidateWorkspace, stageCandidateFiles } from '../src/candidate-workspace.js';
import { sanitizeTaskId } from '../src/real-block-run-ai.js';

let counter = 0;

function createTmpDir(): string {
  const id = `${Date.now()}-${counter++}`;
  const base = join(process.cwd(), 'tmp');
  if (!existsSync(base)) mkdirSync(base);
  return mkdtempSync(join(base, `cr-${id}-`));
}

function getCleanEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^(REAL_REPO_|REAL_BLOCK_|KIMI_|MOCK_|ALLOW_|SANDBOX_|OPENAI_|TASKS_FILE|RUNS_DIR|NODE_TEST_CONTEXT)/.test(key)) {
      delete env[key];
    }
  }
  env.AI_PROVIDER = 'mock';
  return env;
}

function runCli(args: string[], envOverrides: Record<string, string> = {}) {
  const env = { ...getCleanEnv(), ...envOverrides };
  const result = spawnSync(
    `npx tsx "${join(process.cwd(), 'src', 'cli.ts')}" ${args.join(' ')}`,
    { cwd: process.cwd(), env, encoding: 'utf-8', shell: true, timeout: 30000 }
  );
  return { status: result.status ?? 1, stdout: result.stdout || '', stderr: result.stderr || '' };
}

describe('crash-resume', () => {
  test('resumes from reviewer_pending state and completes acceptance flow', () => {
    const id = `${Date.now()}-${counter++}`;
    const taskId = `cr-${id}`;
    const tmpDir = createTmpDir();
    const repoPath = join(tmpDir, 'repo');
    const originPath = join(tmpDir, 'origin.git');
    const runsDir = join(tmpDir, 'runs');
    mkdirSync(repoPath);
    writeFileSync(join(repoPath, 'README.md'), '# hello\n', 'utf-8');
    spawnSync('git', ['init'], { cwd: repoPath, shell: false, encoding: 'utf-8' });
    spawnSync('git', ['config', 'user.email', 'ci@example.com'], { cwd: repoPath, shell: false, encoding: 'utf-8' });
    spawnSync('git', ['config', 'user.name', 'CI User'], { cwd: repoPath, shell: false, encoding: 'utf-8' });
    spawnSync('git', ['add', '.'], { cwd: repoPath, shell: false, encoding: 'utf-8' });
    spawnSync('git', ['commit', '-m', 'init', '--no-gpg-sign'], { cwd: repoPath, shell: false, encoding: 'utf-8' });
    spawnSync('git', ['branch', '-m', 'main'], { cwd: repoPath, shell: false, encoding: 'utf-8' });
    spawnSync('git', ['checkout', '-b', `ai/${taskId}`], { cwd: repoPath, shell: false, encoding: 'utf-8' });
    spawnSync('git', ['init', '--bare', originPath], { shell: false, encoding: 'utf-8' });
    spawnSync('git', ['remote', 'add', 'origin', originPath], { cwd: repoPath, shell: false, encoding: 'utf-8' });
    spawnSync('git', ['push', 'origin', 'main'], { cwd: repoPath, shell: false, encoding: 'utf-8' });

    const tasksFilePath = join(tmpDir, 'tasks.yaml');
    writeFileSync(
      tasksFilePath,
      `tasks:
  - id: ${taskId}
    title: "Crash resume test"
    repo_path: "${repoPath.replace(/\\/g, '/')}"
    base_branch: "main"
    work_branch: "ai/${taskId}"
    goal: "Modify README"
    context_files: []
    checks:
      - command: "node"
        args: ["-e", "process.exit(0)"]
    guardrails:
      deny_modify:
        - ".env"
        - ".env.*"
        - "node_modules/**"
      max_lines_changed: 150
      require_tests: false
      auto_commit: false
      auto_push: false
      auto_merge: false
`,
      'utf-8'
    );

    const task = loadTask(tasksFilePath, taskId);

    // Set up the candidate workspace as if the coder stage had just completed
    // and the process crashed before the reviewer gate ran.
    const candidatePath = join(getRunDir(taskId, runsDir), 'workspaces', sanitizeTaskId(taskId));
    const baseSha = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repoPath, shell: false, encoding: 'utf-8' }).stdout.trim();
    createCandidateWorkspace(candidatePath, repoPath, baseSha, `ai/${taskId}`, taskId);
    writeFileSync(join(candidatePath, 'README.md'), '# resumed\n', 'utf-8');
    stageCandidateFiles(candidatePath, ['README.md']);

    const snapshot: CandidateSnapshot = {
      attemptId: 'crash-checking',
      phase: 'checking',
      taskBaseSha: baseSha,
      changedFiles: ['README.md'],
      fileContents: [{ path: 'README.md', content: '# resumed\n', sha256: computeFileHash('# resumed\n') }],
      candidatePackageHash: '',
    };

    const state = initState(task);
    state.task_phase = 'reviewer_pending';
    state.expected_changed_files = ['README.md'];
    state.task_base_sha = baseSha;
    state.candidate_path = candidatePath;
    saveState(taskId, state, runsDir);
    saveCandidateSnapshot(runsDir, taskId, snapshot);

    try {
      const result = runCli(['real-repo-run-ai', taskId], {
        TASKS_FILE: tasksFilePath,
        RUNS_DIR: runsDir,
        ALLOW_REAL_PROVIDER: 'true',
        ALLOW_REAL_REPO_APPLY: 'true',
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_PUSH: 'true',
        KIMI_API_KEY: 'fake',
        KIMI_BASE_URL: 'http://localhost:9999',
        REAL_REPO_RUN_RESUME: '1',
        REAL_REPO_REVIEWER_FAKE_RESPONSE: JSON.stringify({
          decision: 'accept',
          confidence: 'high',
          blockingIssues: [],
          nonBlockingIssues: [],
          reviewSummary: 'Resume acceptance.',
          nextAction: 'continue',
        }),
      });
      assert.strictEqual(result.status, 0, `Expected resume success: ${result.stderr}`);
      const content = readFileSync(join(repoPath, 'README.md'), 'utf-8').replace(/\r\n/g, '\n');
      assert.strictEqual(content, '# resumed\n', 'main repo should reflect the resumed workspace');
      const headSha = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repoPath, shell: false, encoding: 'utf-8' }).stdout.trim();
      const msg = spawnSync('git', ['log', '-1', '--pretty=%B'], { cwd: repoPath, shell: false, encoding: 'utf-8' }).stdout.trim();
      assert.strictEqual(msg, `ai-orchestrator: ${taskId}`, `unexpected commit message: ${msg}`);
      assert.strictEqual(headSha.length, 40, 'expected a full commit sha');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

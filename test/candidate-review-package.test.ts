import { describe, test, before } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { buildCandidateReviewPackage, computeCandidateReviewPackageHash, saveCandidateReviewPackage, loadCandidateReviewPackage } from '../src/candidate-review-package.js';
import { createCandidateWorkspace, getCandidateDiff } from '../src/candidate-workspace.js';
import { buildReviewerPrompt } from '../src/reviewer/reviewer-prompt.js';
import { buildReviewInput } from '../src/reviewer/review-input-builder.js';
import { buildFixTaskPrompt } from '../src/reviewer-fix-task-real-executor.js';
import type { Task } from '../src/types.js';

let counter = 0;

function tmpDir(): string {
  const base = join(process.cwd(), 'tmp');
  if (!existsSync(base)) mkdirSync(base);
  return mkdtempSync(join(base, `crp-${Date.now()}-${counter++}-`));
}

function initRepo(path: string): void {
  spawnSync('git', ['init'], { cwd: path, encoding: 'utf-8', shell: false });
  spawnSync('git', ['config', 'user.email', 'test@test.com'], { cwd: path, encoding: 'utf-8', shell: false });
  spawnSync('git', ['config', 'user.name', 'Test'], { cwd: path, encoding: 'utf-8', shell: false });
  spawnSync('git', ['config', 'core.autocrlf', 'false'], { cwd: path, encoding: 'utf-8', shell: false });
  mkdirSync(join(path, 'src', 'autopilot-one-click'), { recursive: true });
  writeFileSync(join(path, 'src', 'cli.ts'), 'export const cli = 1;\n', 'utf-8');
  writeFileSync(join(path, 'src', 'autopilot-one-click', 'index.ts'), 'export const index = 1;\n', 'utf-8');
  spawnSync('git', ['add', '.'], { cwd: path, encoding: 'utf-8', shell: false });
  spawnSync('git', ['commit', '-m', 'init', '--no-gpg-sign'], { cwd: path, encoding: 'utf-8', shell: false });
}

function getBaseSha(repoPath: string): string {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repoPath, encoding: 'utf-8', shell: false });
  return result.stdout.trim();
}

function makeTask(candidatePath: string): Task {
  return {
    id: 'doc-01-one-click',
    title: 'Create 01-one-click.md documentation',
    repo_path: candidatePath,
    base_branch: 'main',
    work_branch: 'mission-doc-01-one-click',
    goal: 'Create docs/autonomous-workflow/01-one-click.md',
    context_files: ['src/cli.ts', 'src/autopilot-one-click/index.ts'],
    checks: [],
    guardrails: {
      allow_modify: ['docs/autonomous-workflow/01-one-click.md'],
      deny_modify: ['.env'],
      max_lines_changed: 400,
      auto_commit: false,
      auto_push: false,
      auto_merge: false,
    },
    acceptance_criteria: ['doc is created'],
  };
}

describe('CandidateReviewPackage', () => {
  let repoPath: string;
  let baseSha: string;
  let candidatePath: string;

  before(() => {
    repoPath = tmpDir();
    initRepo(repoPath);
    baseSha = getBaseSha(repoPath);
    const workspaceDir = join(tmpDir(), 'candidate');
    const result = createCandidateWorkspace(workspaceDir, repoPath, baseSha, 'mission-doc-01-one-click', 'doc-01-one-click');
    assert.strictEqual(result.ok, true, result.reason);
    candidatePath = workspaceDir;
  });

  test('staged NEW 10KB file produces non-empty diff', () => {
    const content = '# One-Click Autopilot\n\n' + 'x'.repeat(10000);
    const filePath = join(candidatePath, 'docs', 'autonomous-workflow', '01-one-click.md');
    mkdirSync(join(candidatePath, 'docs', 'autonomous-workflow'), { recursive: true });
    writeFileSync(filePath, content, 'utf-8');
    spawnSync('git', ['add', 'docs/autonomous-workflow/01-one-click.md'], { cwd: candidatePath, encoding: 'utf-8', shell: false });

    const diffInfo = getCandidateDiff(candidatePath, baseSha);
    assert.deepStrictEqual(diffInfo.changedFiles, ['docs/autonomous-workflow/01-one-click.md']);
    assert(diffInfo.diff.length > 0, 'expected non-empty staged diff');
    assert(diffInfo.diff.includes('+'), 'expected added lines in diff');
  });

  test('package bytes/hash match actual staged file', () => {
    const content = '# One-Click Autopilot\n\n' + 'x'.repeat(10000);
    const filePath = join(candidatePath, 'docs', 'autonomous-workflow', '01-one-click.md');
    writeFileSync(filePath, content, 'utf-8');
    spawnSync('git', ['add', 'docs/autonomous-workflow/01-one-click.md'], { cwd: candidatePath, encoding: 'utf-8', shell: false });

    const pkg = buildCandidateReviewPackage({
      candidatePath,
      taskBaseSha: baseSha,
      task: makeTask(candidatePath),
      checkSummary: { typecheck: 'not_run', build: 'not_run', test: 'not_run' },
    });

    assert.strictEqual(pkg.files.length, 1);
    assert.strictEqual(pkg.files[0].path, 'docs/autonomous-workflow/01-one-click.md');
    assert.strictEqual(pkg.files[0].bytes, Buffer.byteLength(content, 'utf-8'));
    assert.strictEqual(pkg.files[0].content, content);
    assert.strictEqual(pkg.candidate_package_hash, computeCandidateReviewPackageHash(pkg.files));
  });

  test('package diff hash is deterministic', () => {
    const content = 'hello\n';
    const filePath = join(candidatePath, 'docs', 'autonomous-workflow', '01-one-click.md');
    writeFileSync(filePath, content, 'utf-8');
    spawnSync('git', ['add', 'docs/autonomous-workflow/01-one-click.md'], { cwd: candidatePath, encoding: 'utf-8', shell: false });

    const pkg1 = buildCandidateReviewPackage({
      candidatePath,
      taskBaseSha: baseSha,
      task: makeTask(candidatePath),
      checkSummary: {},
    });
    const pkg2 = buildCandidateReviewPackage({
      candidatePath,
      taskBaseSha: baseSha,
      task: makeTask(candidatePath),
      checkSummary: {},
    });
    assert.strictEqual(pkg1.staged_diff_sha256, pkg2.staged_diff_sha256);
    assert.strictEqual(pkg1.candidate_package_hash, pkg2.candidate_package_hash);
  });

  test('reviewer prompt contains staged new-file diff content', () => {
    const content = '# One-Click Autopilot\n';
    const filePath = join(candidatePath, 'docs', 'autonomous-workflow', '01-one-click.md');
    writeFileSync(filePath, content, 'utf-8');
    spawnSync('git', ['add', 'docs/autonomous-workflow/01-one-click.md'], { cwd: candidatePath, encoding: 'utf-8', shell: false });

    const pkg = buildCandidateReviewPackage({
      candidatePath,
      taskBaseSha: baseSha,
      task: makeTask(candidatePath),
      checkSummary: {},
    });
    const input = buildReviewInput({
      taskId: pkg.task_id,
      repoPath: candidatePath,
      taskTitle: pkg.task_id,
      taskGoal: 'Create doc',
      allowedFiles: pkg.allowed_files,
      deniedFiles: pkg.denied_files,
      maxLinesChanged: 400,
      acceptanceCriteria: pkg.acceptance_criteria,
      commitSha: baseSha,
      changedFiles: pkg.changed_files,
      diff: pkg.staged_diff,
      typecheckResult: 'not_run',
      buildResult: 'not_run',
      testResult: 'not_run',
      gitStatus: '',
      safetyFindings: [],
      candidateState: {
        base_sha: pkg.task_base_sha,
        package_hash: pkg.candidate_package_hash,
        files: pkg.files,
      },
    });
    const prompt = buildReviewerPrompt(input);
    assert(prompt.includes('# Candidate Base SHA'));
    assert(prompt.includes('# Candidate Package Hash'));
    assert(prompt.includes(pkg.candidate_package_hash));
    assert(prompt.includes('pre-commit staged candidate'));
    assert(prompt.includes('# One-Click Autopilot'));
    assert(!prompt.includes('# Commit SHA'));
  });

  test('reviewer prompt labels base SHA as Candidate Base SHA, not commit', () => {
    const filePath = join(candidatePath, 'docs', 'autonomous-workflow', '01-one-click.md');
    writeFileSync(filePath, 'x', 'utf-8');
    spawnSync('git', ['add', 'docs/autonomous-workflow/01-one-click.md'], { cwd: candidatePath, encoding: 'utf-8', shell: false });

    const pkg = buildCandidateReviewPackage({
      candidatePath,
      taskBaseSha: baseSha,
      task: makeTask(candidatePath),
      checkSummary: {},
    });
    const input = buildReviewInput({
      taskId: pkg.task_id,
      repoPath: candidatePath,
      taskTitle: pkg.task_id,
      taskGoal: 'Create doc',
      allowedFiles: pkg.allowed_files,
      deniedFiles: pkg.denied_files,
      commitSha: baseSha,
      changedFiles: pkg.changed_files,
      diff: pkg.staged_diff,
      typecheckResult: 'not_run',
      buildResult: 'not_run',
      testResult: 'not_run',
      gitStatus: '',
      safetyFindings: [],
      candidateState: {
        base_sha: pkg.task_base_sha,
        package_hash: pkg.candidate_package_hash,
        files: pkg.files,
      },
    });
    const prompt = buildReviewerPrompt(input);
    assert(prompt.includes(`# Candidate Base SHA\n${baseSha}`));
    assert(!prompt.includes('# Commit SHA\n'));
  });

  test('candidate does not need pre-review commit', () => {
    const filePath = join(candidatePath, 'docs', 'autonomous-workflow', '01-one-click.md');
    writeFileSync(filePath, 'content', 'utf-8');
    spawnSync('git', ['add', 'docs/autonomous-workflow/01-one-click.md'], { cwd: candidatePath, encoding: 'utf-8', shell: false });

    const headResult = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: candidatePath, encoding: 'utf-8', shell: false });
    assert.strictEqual(headResult.stdout.trim(), baseSha);

    const pkg = buildCandidateReviewPackage({
      candidatePath,
      taskBaseSha: baseSha,
      task: makeTask(candidatePath),
      checkSummary: {},
    });
    assert.strictEqual(pkg.files.length, 1);
  });

  test('reviewer gets context_files contents as read-only context', () => {
    const filePath = join(candidatePath, 'docs', 'autonomous-workflow', '01-one-click.md');
    writeFileSync(filePath, 'doc', 'utf-8');
    spawnSync('git', ['add', 'docs/autonomous-workflow/01-one-click.md'], { cwd: candidatePath, encoding: 'utf-8', shell: false });

    const pkg = buildCandidateReviewPackage({
      candidatePath,
      taskBaseSha: baseSha,
      task: makeTask(candidatePath),
      checkSummary: {},
    });
    const input = buildReviewInput({
      taskId: pkg.task_id,
      repoPath: candidatePath,
      taskTitle: pkg.task_id,
      taskGoal: 'Create doc',
      allowedFiles: pkg.allowed_files,
      deniedFiles: pkg.denied_files,
      commitSha: baseSha,
      changedFiles: pkg.changed_files,
      diff: pkg.staged_diff,
      typecheckResult: 'not_run',
      buildResult: 'not_run',
      testResult: 'not_run',
      gitStatus: '',
      safetyFindings: [],
      readOnlyContext: {
        files: pkg.read_only_context,
        total_bytes: pkg.read_only_context_total_bytes,
        truncated: pkg.read_only_context_truncated,
      },
    });
    const prompt = buildReviewerPrompt(input);
    assert(prompt.includes('## Read-Only Repository Context'));
    assert(prompt.includes('export const cli = 1;'));
    assert(prompt.includes('src/autopilot-one-click/index.ts'));
  });

  test('reviewer context remains read-only and does not grant write permission', () => {
    const filePath = join(candidatePath, 'docs', 'autonomous-workflow', '01-one-click.md');
    writeFileSync(filePath, 'doc', 'utf-8');
    spawnSync('git', ['add', 'docs/autonomous-workflow/01-one-click.md'], { cwd: candidatePath, encoding: 'utf-8', shell: false });

    const pkg = buildCandidateReviewPackage({
      candidatePath,
      taskBaseSha: baseSha,
      task: makeTask(candidatePath),
      checkSummary: {},
    });
    assert.strictEqual(pkg.allowed_files.join(','), 'docs/autonomous-workflow/01-one-click.md');
    assert(!pkg.allowed_files.includes('src/cli.ts'));
    assert(pkg.read_only_context.some((f) => f.path === 'src/cli.ts'));
  });

  test('reviewer gets dependency evidence independently from context_files', () => {
    const filePath = join(candidatePath, 'docs', 'autonomous-workflow', '01-one-click.md');
    writeFileSync(filePath, 'doc', 'utf-8');
    spawnSync('git', ['add', 'docs/autonomous-workflow/01-one-click.md'], { cwd: candidatePath, encoding: 'utf-8', shell: false });

    const depEvidence = {
      items: [
        {
          task_id: 'prev',
          task_status: 'accepted',
          path: 'docs/prev.md',
          content_sha256: 'a'.repeat(64),
          bytes: 10,
          lines: 1,
          content: 'previous',
        },
      ],
      total_bytes: 10,
      truncated: false,
      omitted_count: 0,
    };
    const pkg = buildCandidateReviewPackage({
      candidatePath,
      taskBaseSha: baseSha,
      task: makeTask(candidatePath),
      checkSummary: {},
      dependencyEvidence: depEvidence,
    });
    assert.strictEqual(pkg.dependency_evidence?.items.length, 1);
    assert(pkg.read_only_context.some((f) => f.path === 'src/cli.ts'));
    assert(pkg.dependency_evidence.items[0].path === 'docs/prev.md');
  });

  test('fix coder prompt receives current candidate full contents', () => {
    const content = 'CANONICAL_DETAIL_MARKER\nline2\n';
    const filePath = join(candidatePath, 'docs', 'autonomous-workflow', '01-one-click.md');
    writeFileSync(filePath, content, 'utf-8');
    spawnSync('git', ['add', 'docs/autonomous-workflow/01-one-click.md'], { cwd: candidatePath, encoding: 'utf-8', shell: false });

    const pkg = buildCandidateReviewPackage({
      candidatePath,
      taskBaseSha: baseSha,
      task: makeTask(candidatePath),
      checkSummary: {},
    });
    const prompt = buildFixTaskPrompt(
      {
        taskId: 'fix-doc-01-one-click-1',
        parentTaskId: 'doc-01-one-click',
        attempt: 1,
        title: 'Fix doc',
        goal: 'Fix one factual sentence',
        blockingIssues: ['Correct one factual sentence'],
        executionRequest: undefined as unknown as never,
        fixTask: undefined as unknown as never,
      },
      {
        parentGoal: 'Create doc',
        allowedFiles: pkg.allowed_files,
        deniedFiles: pkg.denied_files,
        previousChangedFiles: pkg.changed_files,
        checks: [],
        currentHead: baseSha,
        currentCandidateFiles: pkg.files,
      }
    );
    assert(prompt.includes('# Current Candidate Files'));
    assert(prompt.includes('CANONICAL_DETAIL_MARKER'));
  });

  test('fix coder prompt receives context_files contents', () => {
    const filePath = join(candidatePath, 'docs', 'autonomous-workflow', '01-one-click.md');
    writeFileSync(filePath, 'doc', 'utf-8');
    spawnSync('git', ['add', 'docs/autonomous-workflow/01-one-click.md'], { cwd: candidatePath, encoding: 'utf-8', shell: false });

    const pkg = buildCandidateReviewPackage({
      candidatePath,
      taskBaseSha: baseSha,
      task: makeTask(candidatePath),
      checkSummary: {},
    });
    const prompt = buildFixTaskPrompt(
      {
        taskId: 'fix-doc-01-one-click-1',
        parentTaskId: 'doc-01-one-click',
        attempt: 1,
        title: 'Fix doc',
        goal: 'Fix one factual sentence',
        blockingIssues: ['Correct one factual sentence'],
        executionRequest: undefined as unknown as never,
        fixTask: undefined as unknown as never,
      },
      {
        parentGoal: 'Create doc',
        allowedFiles: pkg.allowed_files,
        deniedFiles: pkg.denied_files,
        previousChangedFiles: pkg.changed_files,
        checks: [],
        currentHead: baseSha,
        currentCandidateFiles: pkg.files,
        readOnlyContext: pkg.read_only_context,
      }
    );
    assert(prompt.includes('# Read-Only Repository Context'));
    assert(prompt.includes('export const cli = 1;'));
  });

  test('fix coder prompt cannot mutate context-only source', () => {
    const filePath = join(candidatePath, 'docs', 'autonomous-workflow', '01-one-click.md');
    writeFileSync(filePath, 'doc', 'utf-8');
    spawnSync('git', ['add', 'docs/autonomous-workflow/01-one-click.md'], { cwd: candidatePath, encoding: 'utf-8', shell: false });

    const pkg = buildCandidateReviewPackage({
      candidatePath,
      taskBaseSha: baseSha,
      task: makeTask(candidatePath),
      checkSummary: {},
    });
    const prompt = buildFixTaskPrompt(
      {
        taskId: 'fix-doc-01-one-click-1',
        parentTaskId: 'doc-01-one-click',
        attempt: 1,
        title: 'Fix doc',
        goal: 'Fix one factual sentence',
        blockingIssues: ['Correct one factual sentence'],
        executionRequest: undefined as unknown as never,
        fixTask: undefined as unknown as never,
      },
      {
        parentGoal: 'Create doc',
        allowedFiles: pkg.allowed_files,
        deniedFiles: pkg.denied_files,
        previousChangedFiles: pkg.changed_files,
        checks: [],
        currentHead: baseSha,
        currentCandidateFiles: pkg.files,
        readOnlyContext: pkg.read_only_context,
      }
    );
    assert(prompt.includes('must NOT be modified'));
    assert(!pkg.allowed_files.includes('src/cli.ts'));
  });

  test('save/load package roundtrip preserves hash and diff', () => {
    const filePath = join(candidatePath, 'docs', 'autonomous-workflow', '01-one-click.md');
    writeFileSync(filePath, 'doc', 'utf-8');
    spawnSync('git', ['add', 'docs/autonomous-workflow/01-one-click.md'], { cwd: candidatePath, encoding: 'utf-8', shell: false });

    const pkg = buildCandidateReviewPackage({
      candidatePath,
      taskBaseSha: baseSha,
      task: makeTask(candidatePath),
      checkSummary: {},
    });
    const runsDir = tmpDir();
    saveCandidateReviewPackage(runsDir, pkg.task_id, pkg);
    const loaded = loadCandidateReviewPackage(runsDir, pkg.task_id);
    assert.ok(loaded);
    assert.strictEqual(loaded.candidate_package_hash, pkg.candidate_package_hash);
    assert.strictEqual(loaded.staged_diff_sha256, pkg.staged_diff_sha256);
    assert.strictEqual(loaded.files[0].content, pkg.files[0].content);
  });

  test('second reviewer receives updated candidate package hash after fix', () => {
    const filePath = join(candidatePath, 'docs', 'autonomous-workflow', '01-one-click.md');
    writeFileSync(filePath, 'version one\n', 'utf-8');
    spawnSync('git', ['add', 'docs/autonomous-workflow/01-one-click.md'], { cwd: candidatePath, encoding: 'utf-8', shell: false });

    const firstPkg = buildCandidateReviewPackage({
      candidatePath,
      taskBaseSha: baseSha,
      task: makeTask(candidatePath),
      checkSummary: {},
    });

    writeFileSync(filePath, 'version two\n', 'utf-8');
    spawnSync('git', ['add', 'docs/autonomous-workflow/01-one-click.md'], { cwd: candidatePath, encoding: 'utf-8', shell: false });

    const secondPkg = buildCandidateReviewPackage({
      candidatePath,
      taskBaseSha: baseSha,
      task: makeTask(candidatePath),
      checkSummary: {},
    });

    assert.notStrictEqual(firstPkg.candidate_package_hash, secondPkg.candidate_package_hash);
    assert.strictEqual(secondPkg.files[0].content, 'version two\n');
  });

  test('accepted package hash matches current candidate before commit', () => {
    const filePath = join(candidatePath, 'docs', 'autonomous-workflow', '01-one-click.md');
    writeFileSync(filePath, 'accepted content\n', 'utf-8');
    spawnSync('git', ['add', 'docs/autonomous-workflow/01-one-click.md'], { cwd: candidatePath, encoding: 'utf-8', shell: false });

    const acceptedPkg = buildCandidateReviewPackage({
      candidatePath,
      taskBaseSha: baseSha,
      task: makeTask(candidatePath),
      checkSummary: {},
    });

    const currentPkg = buildCandidateReviewPackage({
      candidatePath,
      taskBaseSha: baseSha,
      task: makeTask(candidatePath),
      checkSummary: {},
    });

    assert.strictEqual(acceptedPkg.candidate_package_hash, currentPkg.candidate_package_hash);
  });

  test('accepted package hash mismatch after drift signals fail-closed', () => {
    const filePath = join(candidatePath, 'docs', 'autonomous-workflow', '01-one-click.md');
    writeFileSync(filePath, 'accepted content\n', 'utf-8');
    spawnSync('git', ['add', 'docs/autonomous-workflow/01-one-click.md'], { cwd: candidatePath, encoding: 'utf-8', shell: false });

    const acceptedPkg = buildCandidateReviewPackage({
      candidatePath,
      taskBaseSha: baseSha,
      task: makeTask(candidatePath),
      checkSummary: {},
    });

    // Simulate external drift after reviewer acceptance.
    writeFileSync(filePath, 'tampered content\n', 'utf-8');
    spawnSync('git', ['add', 'docs/autonomous-workflow/01-one-click.md'], { cwd: candidatePath, encoding: 'utf-8', shell: false });

    const currentPkg = buildCandidateReviewPackage({
      candidatePath,
      taskBaseSha: baseSha,
      task: makeTask(candidatePath),
      checkSummary: {},
    });

    assert.notStrictEqual(acceptedPkg.candidate_package_hash, currentPkg.candidate_package_hash);
  });
});

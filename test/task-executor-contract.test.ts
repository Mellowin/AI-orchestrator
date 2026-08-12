import { describe, test } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import YAML from 'yaml';
import {
  buildTaskExecutorInput,
  buildSingleTaskYaml,
  extractTaskFromExecutorInput,
} from '../src/task-executor-input.js';
import type { BlockDefinition, BlockTaskDefinition } from '../src/block/block-types.js';
import type { DependencyEvidencePackage, Task } from '../src/types.js';

function makeDependencyEvidence(): DependencyEvidencePackage {
  return {
    items: [
      {
        task_id: 'ancestor-1',
        task_status: 'accepted',
        accepted_commit_sha: 'a'.repeat(40),
        path: 'src/ancestor.ts',
        content_sha256: 'b'.repeat(64),
        bytes: 42,
        lines: 3,
        content: 'export const ancestor = 1;\n',
        truncated: false,
      },
    ],
    total_bytes: 42,
    truncated: false,
    omitted_count: 0,
  };
}

function makeBlock(overrides?: Partial<BlockDefinition>): BlockDefinition {
  return {
    block_id: 'block-1',
    title: 'Test Block',
    repo_path: '/tmp/fake-repo',
    base_branch: 'main',
    work_branch: 'ai/block-1',
    providers: {
      coder: { provider: 'fake', model: 'fake' },
      reviewer: { provider: 'fake', model: 'fake' },
    },
    review_policy: {
      require_deterministic_checks: false,
      max_fix_attempts: 1,
      reviewer_mode: 'single',
    },
    tasks: [],
    ...overrides,
  };
}

function makeBlockTask(overrides?: Partial<BlockTaskDefinition>): BlockTaskDefinition {
  return {
    task_id: 'task-1',
    title: 'Test Task',
    goal: 'Test goal',
    allowed_files: ['src/index.ts'],
    denied_files: ['.env'],
    max_lines_changed: 100,
    checks: [],
    ...overrides,
  };
}

function createTempRepo(): { repoPath: string; cleanup: () => void } {
  const tmpDir = mkdtempSync(join(tmpdir(), 'task-executor-contract-'));
  const repoPath = join(tmpDir, 'repo');
  mkdirSync(repoPath);
  writeFileSync(join(repoPath, 'README.md'), '# hello\n', 'utf-8');
  mkdirSync(join(repoPath, 'src'), { recursive: true });
  writeFileSync(join(repoPath, 'src', 'index.ts'), 'export const x = 1;\n', 'utf-8');
  spawnSync('git', ['init'], { cwd: repoPath, encoding: 'utf-8', shell: false });
  spawnSync('git', ['config', 'user.email', 'ci@example.com'], { cwd: repoPath, encoding: 'utf-8', shell: false });
  spawnSync('git', ['config', 'user.name', 'CI User'], { cwd: repoPath, encoding: 'utf-8', shell: false });
  spawnSync('git', ['add', '.'], { cwd: repoPath, encoding: 'utf-8', shell: false });
  spawnSync('git', ['commit', '-m', 'init', '--no-gpg-sign'], { cwd: repoPath, encoding: 'utf-8', shell: false });
  spawnSync('git', ['branch', '-m', 'main'], { cwd: repoPath, encoding: 'utf-8', shell: false });
  spawnSync('git', ['checkout', '-b', 'ai/task-1'], { cwd: repoPath, encoding: 'utf-8', shell: false });
  return {
    repoPath,
    cleanup: () => rmSync(tmpDir, { recursive: true, force: true }),
  };
}

function buildFakeKimiOutput(files: Array<{ path: string; content: string }>, notes?: string): string {
  return JSON.stringify({ mode: 'file_update', files, notes });
}

function buildFakeReviewerResponse(): string {
  return JSON.stringify({
    decision: 'accept',
    confidence: 'high',
    blockingIssues: [],
    nonBlockingIssues: [],
    reviewSummary: 'Default test reviewer acceptance.',
    nextAction: 'continue',
  });
}

describe('task executor contract', () => {
  test('TaskExecutorInput round-trips through JSON', () => {
    const block = makeBlock({ repo_path: '/tmp/fake-repo' });
    const task = makeBlockTask({ dependency_evidence: makeDependencyEvidence() });
    const input = buildTaskExecutorInput(block, task, {
      taskBaseSha: 'base'.padEnd(40, '0'),
      candidatePath: '/tmp/candidate',
      runId: 'run-123',
      attempt: 1,
    });

    const json = JSON.stringify(input);
    const parsed = JSON.parse(json) as typeof input;
    const roundTripped = JSON.parse(json);

    assert.deepStrictEqual(parsed, roundTripped);
    assert.strictEqual(parsed.task.id, input.task.id);
    assert.strictEqual(parsed.task_base_sha, input.task_base_sha);
    assert.strictEqual(parsed.candidate_path, input.candidate_path);
    assert.strictEqual(parsed.run_id, input.run_id);
    assert.strictEqual(parsed.attempt, input.attempt);
    assert.deepStrictEqual(parsed.task.dependency_evidence, makeDependencyEvidence());
  });

  test('extractTaskFromExecutorInput returns the task object', () => {
    const block = makeBlock();
    const task = makeBlockTask();
    const input = buildTaskExecutorInput(block, task, {
      taskBaseSha: 'base'.padEnd(40, '0'),
      candidatePath: '/tmp/candidate',
      runId: 'run-456',
    });

    const extracted = extractTaskFromExecutorInput(input);
    assert.deepStrictEqual(extracted, input.task);
  });

  test('buildTaskExecutorInput uses exact context_files from block task', () => {
    const block = makeBlock();
    const task = makeBlockTask({
      allowed_files: ['docs/new.md'],
      context_files: ['src/cli.ts', 'src/autopilot-one-click/index.ts'],
    });
    const input = buildTaskExecutorInput(block, task, {
      taskBaseSha: 'base'.padEnd(40, '0'),
      candidatePath: '/tmp/candidate',
      runId: 'run-context',
    });

    assert.deepStrictEqual(input.task.context_files, [
      'src/cli.ts',
      'src/autopilot-one-click/index.ts',
    ]);
    assert.deepStrictEqual(input.task.guardrails.allow_modify, ['docs/new.md']);
  });

  test('buildTaskExecutorInput defaults to empty context_files when none provided', () => {
    const block = makeBlock();
    const task = makeBlockTask({ allowed_files: ['docs/new.md'] });
    const input = buildTaskExecutorInput(block, task, {
      taskBaseSha: 'base'.padEnd(40, '0'),
      candidatePath: '/tmp/candidate',
      runId: 'run-empty-context',
    });

    assert.deepStrictEqual(input.task.context_files, []);
  });

  test('buildTaskExecutorInput does not derive context_files from allowed_files', () => {
    const { repoPath, cleanup } = createTempRepo();
    try {
      const block = makeBlock({ repo_path: repoPath });
      const task = makeBlockTask({ allowed_files: ['README.md'] });
      const input = buildTaskExecutorInput(block, task, {
        taskBaseSha: 'base'.padEnd(40, '0'),
        candidatePath: '/tmp/candidate',
        runId: 'run-not-derived',
      });

      assert.deepStrictEqual(input.task.context_files, []);
      assert.deepStrictEqual(input.task.guardrails.allow_modify, ['README.md']);
    } finally {
      cleanup();
    }
  });

  test('TaskExecutorInput survives spawn to child via stdin', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'task-executor-spawn-'));
    const childScript = join(tmpDir, 'child.mjs');
    writeFileSync(
      childScript,
      `import { readFileSync } from 'node:fs';\n` +
        `const data = readFileSync(0, 'utf-8');\n` +
        `process.stdout.write(data);\n`,
      'utf-8'
    );
    try {
      const block = makeBlock();
      const task = makeBlockTask({ dependency_evidence: makeDependencyEvidence() });
      const input = buildTaskExecutorInput(block, task, {
        taskBaseSha: 'base'.padEnd(40, '0'),
        candidatePath: '/tmp/candidate',
        runId: 'run-789',
      });

      const result = spawnSync(process.execPath, [childScript], {
        input: JSON.stringify(input),
        encoding: 'utf-8',
        shell: false,
      });

      assert.strictEqual(result.status, 0, `Child failed: ${result.stderr}`);
      assert.deepStrictEqual(JSON.parse(result.stdout), JSON.parse(JSON.stringify(input)));
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('buildSingleTaskYaml debug artifact includes dependency_evidence', () => {
    const evidence = makeDependencyEvidence();
    const block = makeBlock();
    const task = makeBlockTask({ dependency_evidence: evidence });
    const yaml = buildSingleTaskYaml(block, task);
    const parsed = JSON.parse(yaml);
    assert.ok(Array.isArray(parsed.tasks));
    assert.strictEqual(parsed.tasks.length, 1);
    assert.deepStrictEqual(parsed.tasks[0].dependency_evidence, evidence);
    assert.strictEqual(parsed.tasks[0].id, task.task_id);
  });

  test('real-repo-run-ai accepts TaskExecutorInput via stdin', () => {
    const { repoPath, cleanup } = createTempRepo();
    let candidatePath = '';
    try {
      const block = makeBlock({ repo_path: repoPath, work_branch: 'ai/task-1' });
      const task = makeBlockTask({ allowed_files: ['README.md'] });
      const baseSha = spawnSync('git', ['rev-parse', 'HEAD'], {
        cwd: repoPath,
        encoding: 'utf-8',
        shell: false,
      }).stdout.trim();
      candidatePath = join(tmpdir(), `task-executor-stdin-candidate-${Date.now()}`);
      const taskExecutorInput = buildTaskExecutorInput(block, task, {
        taskBaseSha: baseSha,
        candidatePath,
        runId: 'stdin-run-1',
      });

      const originPath = join(resolve(repoPath), '..', 'origin.git');
      mkdirSync(originPath);
      spawnSync('git', ['init', '--bare'], { cwd: originPath, encoding: 'utf-8', shell: false });
      spawnSync('git', ['remote', 'add', 'origin', originPath], { cwd: repoPath, encoding: 'utf-8', shell: false });

      const result = spawnSync(
        process.execPath,
        [join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs'), join(process.cwd(), 'src', 'cli.ts'), 'real-repo-run-ai', task.task_id],
        {
          cwd: process.cwd(),
          env: {
            ...process.env,
            REAL_REPO_TASK_EXECUTOR_INPUT_STDIN: '1',
            ALLOW_REAL_PROVIDER: 'true',
            ALLOW_REAL_REPO_APPLY: 'true',
            ALLOW_REAL_REPO_COMMIT: 'true',
            ALLOW_REAL_REPO_PUSH: 'true',
            KIMI_API_KEY: 'fake',
            KIMI_BASE_URL: 'http://localhost:9999',
            KIMI_FAKE_RESPONSE: buildFakeKimiOutput([{ path: 'README.md', content: '# modified via stdin\n' }]),
            REAL_REPO_REVIEWER_FAKE_RESPONSE: buildFakeReviewerResponse(),
          },
          input: JSON.stringify(taskExecutorInput),
          encoding: 'utf-8',
          shell: false,
          timeout: 30000,
        }
      );

      assert.strictEqual(result.status, 0, `Expected success: ${result.stderr}`);
      // The candidate workspace is cleaned up after push; the committed change
      // should be present in the mission repo after fast-forward.
      const content = readFileSync(join(repoPath, 'README.md'), 'utf-8').replace(/\r\n/g, '\n');
      assert.strictEqual(content, '# modified via stdin\n');
    } finally {
      cleanup();
      rmSync(candidatePath, { recursive: true, force: true });
    }
  });

  test('real-repo-run-ai falls back to TASKS_FILE when stdin signal is absent', () => {
    const { repoPath, cleanup } = createTempRepo();
    const tmpDir = mkdtempSync(join(tmpdir(), 'task-executor-fallback-'));
    try {
      const taskId = 'fallback-task';
      const tasksFile = join(tmpDir, 'tasks.yaml');
      writeFileSync(
        tasksFile,
        YAML.stringify({
          tasks: [
            {
              id: taskId,
              title: 'Fallback Task',
              repo_path: repoPath.replace(/\\/g, '/'),
              base_branch: 'main',
              work_branch: 'ai/task-1',
              goal: 'Test fallback',
              context_files: [],
              checks: [{ command: 'node', args: ['-e', 'process.exit(0)'] }],
              guardrails: {
                deny_modify: ['.env'],
                max_lines_changed: 150,
                auto_commit: false,
                auto_push: false,
                auto_merge: false,
              },
            },
          ],
        }),
        'utf-8'
      );

      const originPath = join(tmpDir, 'origin.git');
      mkdirSync(originPath);
      spawnSync('git', ['init', '--bare'], { cwd: originPath, encoding: 'utf-8', shell: false });
      spawnSync('git', ['remote', 'add', 'origin', originPath], { cwd: repoPath, encoding: 'utf-8', shell: false });

      const result = spawnSync(
        process.execPath,
        [join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs'), join(process.cwd(), 'src', 'cli.ts'), 'real-repo-run-ai', taskId],
        {
          cwd: process.cwd(),
          env: {
            ...process.env,
            TASKS_FILE: tasksFile,
            ALLOW_REAL_PROVIDER: 'true',
            ALLOW_REAL_REPO_APPLY: 'true',
            ALLOW_REAL_REPO_COMMIT: 'true',
            ALLOW_REAL_REPO_PUSH: 'true',
            KIMI_API_KEY: 'fake',
            KIMI_BASE_URL: 'http://localhost:9999',
            KIMI_FAKE_RESPONSE: buildFakeKimiOutput([{ path: 'README.md', content: '# modified via fallback\n' }]),
            REAL_REPO_REVIEWER_FAKE_RESPONSE: buildFakeReviewerResponse(),
          },
          encoding: 'utf-8',
          shell: false,
          timeout: 30000,
        }
      );

      assert.strictEqual(result.status, 0, `Expected success: ${result.stderr}`);
      const content = readFileSync(join(repoPath, 'README.md'), 'utf-8').replace(/\r\n/g, '\n');
      assert.strictEqual(content, '# modified via fallback\n');
    } finally {
      cleanup();
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

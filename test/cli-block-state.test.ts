import { describe, test } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

let counter = 0;

function getCleanEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.AI_PROVIDER;
  delete env.MOCK_AI_RESPONSE;
  delete env.MOCK_REVIEWER_RESPONSE;
  delete env.KIMI_API_KEY;
  delete env.KIMI_MODEL;
  delete env.KIMI_BASE_URL;
  delete env.KIMI_USER_AGENT;
  delete env.KIMI_FAKE_REVIEWER_RESPONSE;
  delete env.REVIEWER_PROVIDER;
  delete env.ALLOW_KIMI_REVIEWER;
  delete env.OPENAI_API_KEY;
  delete env.MOCK_AI;
  delete env.DRY_RUN_TYPECHECK_RESULT;
  delete env.DRY_RUN_BUILD_RESULT;
  delete env.DRY_RUN_TEST_RESULT;
  return env;
}

function runCli(args: string[], envOverrides: Record<string, string> = {}): {
  status: number;
  stdout: string;
  stderr: string;
} {
  const env = { ...getCleanEnv(), ...envOverrides };
  const quotedArgs = args.map((a) => (a.includes(' ') || a.includes('\\') ? `"${a}"` : a));
  const result = spawnSync(
    `npx tsx "${join(process.cwd(), 'src', 'cli.ts')}" ${quotedArgs.join(' ')}`,
    {
      cwd: process.cwd(),
      env,
      encoding: 'utf-8',
      shell: true,
      timeout: 15000,
    }
  );
  return {
    status: result.status ?? 1,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  };
}

function createBlockJson(overrides: Record<string, unknown> = {}): { path: string; blockId: string; cleanup: () => void } {
  const id = `${Date.now()}-${counter++}`;
  const blockId = `cli-bs-${id}`;
  const tmpBase = join(process.cwd(), 'tmp');
  if (!existsSync(tmpBase)) {
    mkdirSync(tmpBase);
  }
  const tmpDir = mkdtempSync(join(tmpBase, `cli-bs-${id}-`));
  const path = join(tmpDir, 'block.json');

  const content = {
    block_id: blockId,
    title: 'CLI Block Test',
    repo_path: '.',
    base_branch: 'main',
    work_branch: 'ai/test',
    providers: {
      coder: { provider: 'fake', model: 'default' },
      reviewer: { provider: 'fake', model: 'default' },
    },
    review_policy: {
      require_deterministic_checks: true,
      max_fix_attempts: 2,
      reviewer_mode: 'single',
    },
    tasks: [
      {
        task_id: 'task-1',
        title: 'Task 1',
        goal: 'Do thing',
        allowed_files: ['src/a.ts'],
        denied_files: ['.env'],
        max_lines_changed: 100,
        checks: ['npm test'],
      },
      {
        task_id: 'task-2',
        title: 'Task 2',
        goal: 'Do thing 2',
        allowed_files: ['src/b.ts'],
        denied_files: ['.env'],
        max_lines_changed: 100,
        checks: ['npm test'],
      },
    ],
    ...overrides,
  };

  writeFileSync(path, JSON.stringify(content), 'utf-8');

  return {
    path,
    blockId,
    cleanup: () => {
      rmSync(tmpDir, { recursive: true, force: true });
      // Also clean up block state
      const blockRunDir = join(process.cwd(), 'runs', 'blocks', blockId);
      if (existsSync(blockRunDir)) {
        rmSync(blockRunDir, { recursive: true, force: true });
      }
    },
  };
}

describe('cli block-state', () => {
  test('block-init creates state file', () => {
    const { path, blockId, cleanup } = createBlockJson();
    try {
      const result = runCli(['block-init', path]);
      assert.strictEqual(result.status, 0, `Expected success, got stderr: ${result.stderr}`);
      const statePath = join(process.cwd(), 'runs', 'blocks', blockId, 'block-state.json');
      assert(existsSync(statePath), `State file should exist at ${statePath}`);
    } finally {
      cleanup();
    }
  });

  test('block-init prints block id/task count/current task', () => {
    const { path, blockId, cleanup } = createBlockJson();
    try {
      const result = runCli(['block-init', path]);
      assert.strictEqual(result.status, 0);
      assert(result.stdout.includes(`Block initialized: ${blockId}`));
      assert(result.stdout.includes('Tasks: 2'));
      assert(result.stdout.includes('Current task: task-1'));
    } finally {
      cleanup();
    }
  });

  test('block-init rejects invalid json', () => {
    const id = `${Date.now()}-${counter++}`;
    const tmpBase = join(process.cwd(), 'tmp');
    if (!existsSync(tmpBase)) {
      mkdirSync(tmpBase);
    }
    const tmpDir = mkdtempSync(join(tmpBase, `cli-bs-bad-${id}-`));
    const path = join(tmpDir, 'bad.json');
    writeFileSync(path, 'not json', 'utf-8');
    try {
      const result = runCli(['block-init', path]);
      assert.strictEqual(result.status, 1);
      assert(result.stderr.includes('JSON'));
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('block-status prints markdown', () => {
    const { path, blockId, cleanup } = createBlockJson();
    try {
      runCli(['block-init', path]);
      const result = runCli(['block-status', blockId]);
      assert.strictEqual(result.status, 0, `Expected success, got stderr: ${result.stderr}`);
      assert(result.stdout.includes('# Block Status Report'));
      assert(result.stdout.includes(blockId));
    } finally {
      cleanup();
    }
  });

  test('block-status missing block fails safely', () => {
    const result = runCli(['block-status', 'nonexistent-block-12345']);
    assert.strictEqual(result.status, 1);
    assert(result.stderr.includes('not found'));
  });

  test('block-transition in_progress updates state', () => {
    const { path, blockId, cleanup } = createBlockJson();
    try {
      runCli(['block-init', path]);
      const result = runCli(['block-transition', blockId, 'task-1', 'in_progress']);
      assert.strictEqual(result.status, 0, `Expected success, got stderr: ${result.stderr}`);
      assert(result.stdout.includes('Transition applied: in_progress'));
      assert(result.stdout.includes('Block status: running'));
    } finally {
      cleanup();
    }
  });

  test('block-transition committed requires sha', () => {
    const { path, blockId, cleanup } = createBlockJson();
    try {
      runCli(['block-init', path]);
      const result = runCli(['block-transition', blockId, 'task-1', 'committed']);
      assert.strictEqual(result.status, 1);
      assert(result.stderr.includes('40-character'));
    } finally {
      cleanup();
    }
  });

  test('block-transition committed stores sha', () => {
    const { path, blockId, cleanup } = createBlockJson();
    try {
      runCli(['block-init', path]);
      const sha = 'a'.repeat(40);
      const result = runCli(['block-transition', blockId, 'task-1', 'committed', sha]);
      assert.strictEqual(result.status, 0, `Expected success, got stderr: ${result.stderr}`);
      assert(result.stdout.includes('Transition applied: committed'));
    } finally {
      cleanup();
    }
  });

  test('block-transition accepted advances task', () => {
    const { path, blockId, cleanup } = createBlockJson();
    try {
      runCli(['block-init', path]);
      const result = runCli(['block-transition', blockId, 'task-1', 'accepted', 'Good']);
      assert.strictEqual(result.status, 0, `Expected success, got stderr: ${result.stderr}`);
      assert(result.stdout.includes('Current task: task-2'));
    } finally {
      cleanup();
    }
  });

  test('block-transition accepted completes final task', () => {
    const { path, blockId, cleanup } = createBlockJson();
    try {
      runCli(['block-init', path]);
      runCli(['block-transition', blockId, 'task-1', 'accepted', 'Good']);
      const result = runCli(['block-transition', blockId, 'task-2', 'accepted', 'Good']);
      assert.strictEqual(result.status, 0, `Expected success, got stderr: ${result.stderr}`);
      assert(result.stdout.includes('Block status: completed'));
      assert(result.stdout.includes('Current task: none'));
    } finally {
      cleanup();
    }
  });

  test('block-transition fix_required increments fix_attempts', () => {
    const { path, blockId, cleanup } = createBlockJson();
    try {
      runCli(['block-init', path]);
      runCli(['block-transition', blockId, 'task-1', 'in_progress']);
      const result = runCli(['block-transition', blockId, 'task-1', 'fix_required', 'Typo']);
      assert.strictEqual(result.status, 0, `Expected success, got stderr: ${result.stderr}`);
      assert(result.stdout.includes('Block status: fixing'));
    } finally {
      cleanup();
    }
  });

  test('block-transition blocked blocks block', () => {
    const { path, blockId, cleanup } = createBlockJson();
    try {
      runCli(['block-init', path]);
      const result = runCli(['block-transition', blockId, 'task-1', 'blocked', 'Security issue']);
      assert.strictEqual(result.status, 0, `Expected success, got stderr: ${result.stderr}`);
      assert(result.stdout.includes('Block status: blocked'));
      assert(result.stdout.includes('Current task: none'));
    } finally {
      cleanup();
    }
  });

  test('block-transition unknown transition fails safely', () => {
    const { path, blockId, cleanup } = createBlockJson();
    try {
      runCli(['block-init', path]);
      const result = runCli(['block-transition', blockId, 'task-1', 'unknown_transition']);
      assert.strictEqual(result.status, 1);
      assert(result.stderr.includes('unknown transition'));
    } finally {
      cleanup();
    }
  });

  test('CLI does not call provider', () => {
    const { path, blockId, cleanup } = createBlockJson();
    try {
      const result = runCli(['block-init', path]);
      assert.strictEqual(result.status, 0);
      assert(result.stdout.includes('No provider call was made'));
    } finally {
      cleanup();
    }
  });

  test('CLI does not call git', () => {
    const { path, blockId, cleanup } = createBlockJson();
    try {
      const result = runCli(['block-init', path]);
      assert.strictEqual(result.status, 0);
      assert(result.stdout.includes('No git command was executed'));
    } finally {
      cleanup();
    }
  });

  test('CLI does not call GitHub API', () => {
    const { path, blockId, cleanup } = createBlockJson();
    try {
      runCli(['block-init', path]);
      const result = runCli(['block-status', blockId]);
      assert.strictEqual(result.status, 0);
      assert(!result.stdout.includes('github.com'));
    } finally {
      cleanup();
    }
  });

  test('CLI does not apply/commit/push/merge/checkout/main touch', () => {
    const { path, blockId, cleanup } = createBlockJson();
    try {
      const result = runCli(['block-init', path]);
      assert.strictEqual(result.status, 0);
      assert(result.stdout.includes('No merge was performed'));
      assert(result.stdout.includes('No checkout was performed'));
      assert(result.stdout.includes('No main touch was performed'));
    } finally {
      cleanup();
    }
  });

  test('CLI no API key leak', () => {
    const { path, blockId, cleanup } = createBlockJson();
    try {
      const result = runCli(['block-init', path]);
      assert.strictEqual(result.status, 0);
      // Check for real-looking secret patterns, not just "sk-" which can appear in "task"
      assert(!result.stdout.includes('sk-abc123'));
      assert(!result.stdout.includes('Bearer SECRET'));
      assert(!result.stdout.includes('GITHUB_TOKEN=ghp_'));
      assert(!result.stderr.includes('sk-abc123'));
    } finally {
      cleanup();
    }
  });

  test('CLI no stack trace', () => {
    const { path, blockId, cleanup } = createBlockJson();
    try {
      const result = runCli(['block-init', path]);
      assert.strictEqual(result.status, 0);
      assert(!result.stderr.includes('at '));
    } finally {
      cleanup();
    }
  });

  test('repeated block-transition fix_required reaches max and blocks block', () => {
    const { path, blockId, cleanup } = createBlockJson({ review_policy: { require_deterministic_checks: true, max_fix_attempts: 2, reviewer_mode: 'single' } });
    try {
      runCli(['block-init', path]);
      runCli(['block-transition', blockId, 'task-1', 'in_progress']);
      runCli(['block-transition', blockId, 'task-1', 'fix_required', 'Typo']);
      // fix_attempts is now 1, status is fixing
      const result2 = runCli(['block-transition', blockId, 'task-1', 'fix_required', 'Still broken']);
      // fix_attempts is now 2, which equals max_fix_attempts=2, so blocked
      assert.strictEqual(result2.status, 0, `Expected success, got stderr: ${result2.stderr}`);
      assert(result2.stdout.includes('Block status: blocked'));
      assert(result2.stdout.includes('Current task: none'));
    } finally {
      cleanup();
    }
  });

  test('starting in_progress after fix_required clears previous issue', () => {
    const { path, blockId, cleanup } = createBlockJson();
    try {
      runCli(['block-init', path]);
      runCli(['block-transition', blockId, 'task-1', 'in_progress']);
      runCli(['block-transition', blockId, 'task-1', 'fix_required', 'Typo']);
      const result = runCli(['block-transition', blockId, 'task-1', 'in_progress']);
      assert.strictEqual(result.status, 0, `Expected success, got stderr: ${result.stderr}`);
      assert(result.stdout.includes('Block status: running'));
      // Verify the state file has cleared blocking_issues
      const statePath = join(process.cwd(), 'runs', 'blocks', blockId, 'block-state.json');
      const raw = readFileSync(statePath, 'utf-8');
      const state = JSON.parse(raw);
      const task = state.tasks.find((t: { task_id: string }) => t.task_id === 'task-1');
      assert.deepStrictEqual(task.blocking_issues, []);
    } finally {
      cleanup();
    }
  });

  test('blocked task cannot be restarted via block-transition in_progress', () => {
    const { path, blockId, cleanup } = createBlockJson();
    try {
      runCli(['block-init', path]);
      const result = runCli(['block-transition', blockId, 'task-1', 'blocked', 'Security issue']);
      assert.strictEqual(result.status, 0);
      const result2 = runCli(['block-transition', blockId, 'task-1', 'in_progress']);
      assert.strictEqual(result2.status, 1);
      assert(result2.stderr.includes('Cannot restart blocked task'));
    } finally {
      cleanup();
    }
  });
});

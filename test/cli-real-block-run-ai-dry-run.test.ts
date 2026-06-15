import { describe, test } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRealBlockRunAIDryRunReport } from '../src/real-block-run-ai-dry-run.js';

const PROJECT_ROOT = process.cwd();
const TSX_CLI_PATH = join(PROJECT_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const CLI_PATH = join(PROJECT_ROOT, 'src', 'cli.ts');
const SOURCE_PATH = join(PROJECT_ROOT, 'src', 'real-block-run-ai-dry-run.ts');

function runCli(args: string[], envOverrides: Record<string, string> = {}): {
  status: number;
  stdout: string;
  stderr: string;
} {
  const env = { ...process.env, ...envOverrides };
  const result = spawnSync(process.execPath, [TSX_CLI_PATH, CLI_PATH, ...args], {
    cwd: PROJECT_ROOT,
    env,
    encoding: 'utf-8',
    shell: false,
    timeout: 30000,
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  };
}

function createTempRepo(): string {
  const tmpDir = mkdtempSync(join(tmpdir(), 'dryrun-test-'));
  const repoPath = join(tmpDir, 'repo');
  mkdirSync(repoPath, { recursive: true });
  spawnSync('git', ['init'], { cwd: repoPath, encoding: 'utf-8', shell: false });
  spawnSync('git', ['config', 'user.email', 'test@example.invalid'], { cwd: repoPath, encoding: 'utf-8', shell: false });
  spawnSync('git', ['config', 'user.name', 'Test'], { cwd: repoPath, encoding: 'utf-8', shell: false });
  writeFileSync(join(repoPath, 'README.md'), '# Test\n', 'utf-8');
  spawnSync('git', ['add', '.'], { cwd: repoPath, encoding: 'utf-8', shell: false });
  spawnSync('git', ['commit', '-m', 'init', '--no-gpg-sign'], { cwd: repoPath, encoding: 'utf-8', shell: false });
  spawnSync('git', ['checkout', '-b', 'ai-block-test'], { cwd: repoPath, encoding: 'utf-8', shell: false });
  return repoPath;
}

let blockCounter = 0;

function createBlockFile(repoPath: string, overrides: Record<string, unknown> = {}): { blockPath: string; blockId: string } {
  blockCounter += 1;
  const blockId = `block_dryrun_${Date.now()}_${blockCounter}`;
  const tmpDir = mkdtempSync(join(tmpdir(), 'dryrun-block-'));
  const blockPath = join(tmpDir, 'block.json');
  const block = {
    block_id: blockId,
    title: 'Dry-run test block',
    repo_path: repoPath.replace(/\\/g, '/'),
    base_branch: 'main',
    work_branch: 'ai-block-test',
    providers: {
      coder: { provider: 'kimi', model: 'kimi-k2.6' },
      reviewer: { provider: 'kimi', model: 'kimi-k2.6' },
    },
    review_policy: {
      require_deterministic_checks: false,
      max_fix_attempts: 1,
      reviewer_mode: 'single',
    },
    tasks: [
      {
        task_id: 'task_1',
        title: 'Update README',
        goal: 'Update README.',
        allowed_files: ['README.md'],
        denied_files: ['package.json'],
        max_lines_changed: 100,
        checks: ['npm run typecheck'],
      },
      {
        task_id: 'task_2',
        title: 'Add note',
        goal: 'Add note.',
        allowed_files: ['NOTE.md'],
        denied_files: [],
        max_lines_changed: 50,
        checks: [],
      },
    ],
    ...overrides,
  };
  writeFileSync(blockPath, JSON.stringify(block, null, 2), 'utf-8');
  return { blockPath, blockId };
}

function buildEnv(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    AI_PROVIDER: 'mock',
    ALLOW_REAL_BLOCK_RUN_AI: 'true',
    ALLOW_REAL_PROVIDER: 'true',
    ALLOW_REAL_REPO_APPLY: 'true',
    ALLOW_REAL_REPO_COMMIT: 'true',
    ALLOW_REAL_REPO_PUSH: 'true',
    KIMI_API_KEY: 'sk-test',
    KIMI_BASE_URL: 'http://localhost.invalid',
    KIMI_MODEL: 'kimi-k2.6',
    ...overrides,
  };
}

function parseOutput(output: string): Record<string, unknown> {
  const match = output.match(/\{[\s\S]*\}/);
  assert.ok(match, 'output should contain JSON');
  return JSON.parse(match[0]) as Record<string, unknown>;
}

function readSource(path: string): string {
  return readFileSync(path, 'utf-8');
}

describe('real-block-run-ai-dry-run CLI', () => {
  test('CLI usage includes real-block-run-ai-dry-run', () => {
    const result = runCli([]);
    assert.notStrictEqual(result.status, 0);
    const output = `${result.stdout}\n${result.stderr}`;
    assert.match(output, /real-block-run-ai-dry-run/);
  });

  test('missing block path exits non-zero', () => {
    const result = runCli(['real-block-run-ai-dry-run']);
    assert.notStrictEqual(result.status, 0);
    const output = `${result.stdout}\n${result.stderr}`;
    assert.match(output, /block definition path is required/i);
  });

  test('valid block with required env outputs parseable JSON', () => {
    const repoPath = createTempRepo();
    const { blockPath } = createBlockFile(repoPath);
    const result = runCli(['real-block-run-ai-dry-run', blockPath], buildEnv());
    assert.strictEqual(result.status, 0, result.stderr);
    const json = parseOutput(result.stdout);
    assert.strictEqual(json.ok, true);
  });

  test('valid output includes mode real-block-run-ai-dry-run', () => {
    const repoPath = createTempRepo();
    const { blockPath } = createBlockFile(repoPath);
    const result = runCli(['real-block-run-ai-dry-run', blockPath], buildEnv());
    const json = parseOutput(result.stdout);
    assert.strictEqual(json.mode, 'real-block-run-ai-dry-run');
  });

  test('valid output includes block id', () => {
    const repoPath = createTempRepo();
    const { blockPath } = createBlockFile(repoPath);
    const result = runCli(['real-block-run-ai-dry-run', blockPath], buildEnv());
    const json = parseOutput(result.stdout);
    assert.ok((json.blockId as string).startsWith('block_dryrun_'));
  });

  test('valid output includes repo path', () => {
    const repoPath = createTempRepo();
    const { blockPath } = createBlockFile(repoPath);
    const result = runCli(['real-block-run-ai-dry-run', blockPath], buildEnv());
    const json = parseOutput(result.stdout);
    assert.strictEqual(typeof json.repoPath, 'string');
    assert.ok((json.repoPath as string).includes('dryrun-test-'));
  });

  test('valid output includes base branch', () => {
    const repoPath = createTempRepo();
    const { blockPath } = createBlockFile(repoPath);
    const result = runCli(['real-block-run-ai-dry-run', blockPath], buildEnv());
    const json = parseOutput(result.stdout);
    assert.strictEqual(json.baseBranch, 'main');
  });

  test('valid output includes work branch', () => {
    const repoPath = createTempRepo();
    const { blockPath } = createBlockFile(repoPath);
    const result = runCli(['real-block-run-ai-dry-run', blockPath], buildEnv());
    const json = parseOutput(result.stdout);
    assert.strictEqual(json.workBranch, 'ai-block-test');
  });

  test('valid output includes provider kimi', () => {
    const repoPath = createTempRepo();
    const { blockPath } = createBlockFile(repoPath);
    const result = runCli(['real-block-run-ai-dry-run', blockPath, '--provider', 'kimi'], buildEnv());
    const json = parseOutput(result.stdout);
    assert.strictEqual(json.provider, 'kimi');
  });

  test('valid output includes task list in order', () => {
    const repoPath = createTempRepo();
    const { blockPath } = createBlockFile(repoPath);
    const result = runCli(['real-block-run-ai-dry-run', blockPath], buildEnv());
    const json = parseOutput(result.stdout);
    const tasks = json.tasks as Array<Record<string, unknown>>;
    assert.ok(Array.isArray(tasks));
    assert.strictEqual(tasks.length, 2);
    assert.strictEqual(tasks[0].task_id, 'task_1');
    assert.strictEqual(tasks[1].task_id, 'task_2');
  });

  test('valid output includes task allowed_files', () => {
    const repoPath = createTempRepo();
    const { blockPath } = createBlockFile(repoPath);
    const result = runCli(['real-block-run-ai-dry-run', blockPath], buildEnv());
    const json = parseOutput(result.stdout);
    const tasks = json.tasks as Array<Record<string, unknown>>;
    assert.deepStrictEqual(tasks[0].allowed_files, ['README.md']);
  });

  test('valid output includes task denied_files', () => {
    const repoPath = createTempRepo();
    const { blockPath } = createBlockFile(repoPath);
    const result = runCli(['real-block-run-ai-dry-run', blockPath], buildEnv());
    const json = parseOutput(result.stdout);
    const tasks = json.tasks as Array<Record<string, unknown>>;
    assert.deepStrictEqual(tasks[0].denied_files, ['package.json']);
  });

  test('valid output includes checks', () => {
    const repoPath = createTempRepo();
    const { blockPath } = createBlockFile(repoPath);
    const result = runCli(['real-block-run-ai-dry-run', blockPath], buildEnv());
    const json = parseOutput(result.stdout);
    const tasks = json.tasks as Array<Record<string, unknown>>;
    assert.deepStrictEqual(tasks[0].checks, ['npm run typecheck']);
  });

  test('valid output includes nextCommands', () => {
    const repoPath = createTempRepo();
    const { blockPath } = createBlockFile(repoPath);
    const result = runCli(['real-block-run-ai-dry-run', blockPath], buildEnv());
    const json = parseOutput(result.stdout);
    const commands = json.nextCommands as string[];
    assert.ok(Array.isArray(commands));
    assert.ok(commands.length >= 3);
  });

  test('valid output includes provider smoke command', () => {
    const repoPath = createTempRepo();
    const { blockPath } = createBlockFile(repoPath);
    const result = runCli(['real-block-run-ai-dry-run', blockPath], buildEnv());
    const json = parseOutput(result.stdout);
    const commands = json.nextCommands as string[];
    assert.ok(commands.some((c) => c.includes('real-provider-smoke')));
  });

  test('valid output includes real run command', () => {
    const repoPath = createTempRepo();
    const { blockPath } = createBlockFile(repoPath);
    const result = runCli(['real-block-run-ai-dry-run', blockPath], buildEnv());
    const json = parseOutput(result.stdout);
    const commands = json.nextCommands as string[];
    assert.ok(commands.some((c) => c.includes('real-block-run-ai')));
  });

  test('valid output includes report command template', () => {
    const repoPath = createTempRepo();
    const { blockPath } = createBlockFile(repoPath);
    const result = runCli(['real-block-run-ai-dry-run', blockPath], buildEnv());
    const json = parseOutput(result.stdout);
    const commands = json.nextCommands as string[];
    assert.ok(commands.some((c) => c.includes('real-block-run-ai-report')));
  });

  test('missing provider env makes ok:false', () => {
    const repoPath = createTempRepo();
    const { blockPath } = createBlockFile(repoPath);
    const env = buildEnv({ ALLOW_REAL_PROVIDER: '', KIMI_API_KEY: '', KIMI_BASE_URL: '' });
    const result = runCli(['real-block-run-ai-dry-run', blockPath], env);
    const json = parseOutput(result.stdout);
    assert.strictEqual(json.ok, false);
  });

  test('missing env output lists names only, not values', () => {
    const repoPath = createTempRepo();
    const { blockPath } = createBlockFile(repoPath);
    const env = buildEnv({ KIMI_API_KEY: '', KIMI_BASE_URL: '' });
    const result = runCli(['real-block-run-ai-dry-run', blockPath], env);
    const json = parseOutput(result.stdout);
    const providerSmoke = json.providerSmoke as Record<string, unknown>;
    assert.deepStrictEqual(providerSmoke.missingEnv, ['KIMI_API_KEY', 'KIMI_BASE_URL']);
    const output = `${result.stdout}\n${result.stderr}`;
    assert.doesNotMatch(output, /sk-test/);
    assert.doesNotMatch(output, /localhost\.invalid/);
  });

  test('unsupported provider makes ok:false', () => {
    const repoPath = createTempRepo();
    const { blockPath } = createBlockFile(repoPath);
    const result = runCli(['real-block-run-ai-dry-run', blockPath, '--provider', 'openai'], buildEnv());
    const json = parseOutput(result.stdout);
    assert.strictEqual(json.ok, false);
    assert.strictEqual(json.provider, 'openai');
  });

  test('unsupported provider does not require KIMI_API_KEY', () => {
    const repoPath = createTempRepo();
    const { blockPath } = createBlockFile(repoPath);
    const env = buildEnv({ KIMI_API_KEY: '', KIMI_BASE_URL: '' });
    const result = runCli(['real-block-run-ai-dry-run', blockPath, '--provider', 'openai'], env);
    const json = parseOutput(result.stdout);
    const providerSmoke = json.providerSmoke as Record<string, unknown>;
    assert.strictEqual(providerSmoke.supported, false);
    assert.strictEqual(providerSmoke.missingEnv, undefined);
  });

  test('unsafe provider string is not echoed raw', () => {
    const repoPath = createTempRepo();
    const { blockPath } = createBlockFile(repoPath);
    const result = runCli(['real-block-run-ai-dry-run', blockPath, '--provider', 'sk-secret-token-123'], buildEnv());
    const output = `${result.stdout}\n${result.stderr}`;
    assert.doesNotMatch(output, /sk-secret-token-123/);
    const json = parseOutput(result.stdout);
    assert.strictEqual(json.provider, 'unknown');
  });

  test('dry-run does not call real provider', () => {
    const repoPath = createTempRepo();
    const { blockPath } = createBlockFile(repoPath);
    const result = runCli(['real-block-run-ai-dry-run', blockPath], buildEnv());
    assert.strictEqual(result.status, 0);
    const output = `${result.stdout}\n${result.stderr}`;
    assert.doesNotMatch(output, /Provider smoke ok/);
  });

  test('source does not call fetch/http/network directly', () => {
    const source = readSource(SOURCE_PATH);
    assert.doesNotMatch(source, /\bfetch\s*\(/);
    assert.doesNotMatch(source, /createKimiClient/);
    assert.doesNotMatch(source, /globalThis\.fetch/);
  });

  test('dry-run does not write state', () => {
    const repoPath = createTempRepo();
    const { blockPath, blockId } = createBlockFile(repoPath);
    const before = existsSync(join(PROJECT_ROOT, 'runs', 'block', blockId));
    runCli(['real-block-run-ai-dry-run', blockPath], buildEnv());
    const after = existsSync(join(PROJECT_ROOT, 'runs', 'block', blockId));
    assert.strictEqual(before, false);
    assert.strictEqual(after, false);
  });

  test('dry-run does not create files in runs/block', () => {
    const repoPath = createTempRepo();
    const { blockPath, blockId } = createBlockFile(repoPath);
    runCli(['real-block-run-ai-dry-run', blockPath], buildEnv());
    const entries = existsSync(join(PROJECT_ROOT, 'runs', 'block', blockId));
    assert.strictEqual(entries, false);
  });

  test('dry-run does not spawn block runner', () => {
    const source = readSource(SOURCE_PATH);
    assert.doesNotMatch(source, /real-block-run-ai\s*\(/);
    assert.doesNotMatch(source, /runRealBlockRunAI/);
    assert.doesNotMatch(source, /runOneTaskLoop/);
    assert.doesNotMatch(source, /runMultiTaskLoop/);
  });

  test('dry-run does not call git commit/push/merge', () => {
    const source = readSource(SOURCE_PATH);
    assert.doesNotMatch(source, /git.*commit/);
    assert.doesNotMatch(source, /git.*push/);
    assert.doesNotMatch(source, /git.*merge/);
  });

  test('dry-run source does not use shell:true', () => {
    const source = readSource(SOURCE_PATH);
    assert.doesNotMatch(source, /shell:\s*true/);
  });

  test('resume flag is reflected in output', () => {
    const repoPath = createTempRepo();
    const { blockPath } = createBlockFile(repoPath);
    const result = runCli(['real-block-run-ai-dry-run', blockPath, '--resume'], buildEnv());
    const json = parseOutput(result.stdout);
    assert.strictEqual(json.resume, true);
  });

  test('resume mode marks already accepted tasks as wouldSkip and next pending', () => {
    const repoPath = createTempRepo();
    const { blockPath, blockId } = createBlockFile(repoPath);

    // Create a partial existing state with task_1 completed.
    const runsDir = join(PROJECT_ROOT, 'runs', 'block', blockId);
    mkdirSync(runsDir, { recursive: true });
    const statePath = join(runsDir, 'state.json');
    const state = {
      block_id: blockId,
      title: 'Dry-run test block',
      status: 'blocked',
      currentTaskId: 'task_2',
      statePath,
      taskResults: [
        {
          taskId: 'task_1',
          title: 'Update README',
          status: 'accepted',
          originalCommitSha: 'a'.repeat(40),
          fixAttempted: false,
          finalStatus: 'accepted',
          nextAction: 'continue',
          childStateTaskId: 'task_1',
        },
      ],
      summary: {
        totalTasks: 2,
        acceptedTasks: 1,
        fixedTasks: 0,
        completedTasks: 1,
        blockedTaskId: 'task_2',
        stoppedReason: 'Blocked for human review',
      },
      startedAt: new Date().toISOString(),
      safetyNote: 'test',
      resumed: true,
    };
    writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf-8');

    try {
      const result = runCli(['real-block-run-ai-dry-run', blockPath, '--resume'], buildEnv());
      const json = parseOutput(result.stdout);
      const tasks = json.tasks as Array<Record<string, unknown>>;
      assert.strictEqual(tasks[0].wouldSkip, true);
      assert.strictEqual(tasks[0].isNext, false);
      assert.strictEqual(tasks[1].wouldSkip, false);
      assert.strictEqual(tasks[1].isNext, true);
      assert.strictEqual(json.readiness.nextTaskId, 'task_2');
    } finally {
      // cleanup state file
      try {
        rmSync(join(PROJECT_ROOT, 'runs', 'block', blockId), { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  });

  test('resume mode reflects known task statuses from state', () => {
    const repoPath = createTempRepo();
    const { blockPath, blockId } = createBlockFile(repoPath);

    const runsDir = join(PROJECT_ROOT, 'runs', 'block', blockId);
    mkdirSync(runsDir, { recursive: true });
    const statePath = join(runsDir, 'state.json');
    const state = {
      block_id: blockId,
      title: 'Dry-run test block',
      status: 'blocked',
      currentTaskId: 'task_2',
      statePath,
      taskResults: [
        {
          taskId: 'task_1',
          title: 'Update README',
          status: 'accepted',
          originalCommitSha: 'a'.repeat(40),
          fixAttempted: false,
          finalStatus: 'accepted',
          nextAction: 'continue',
          childStateTaskId: 'task_1',
        },
      ],
      summary: {
        totalTasks: 2,
        acceptedTasks: 1,
        fixedTasks: 0,
        completedTasks: 1,
        blockedTaskId: 'task_2',
        stoppedReason: 'Blocked',
      },
      startedAt: new Date().toISOString(),
      safetyNote: 'test',
    };
    writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf-8');

    try {
      const result = runCli(['real-block-run-ai-dry-run', blockPath, '--resume'], buildEnv());
      const json = parseOutput(result.stdout);
      const tasks = json.tasks as Array<Record<string, unknown>>;
      assert.strictEqual(tasks[0].status, 'accepted');
      assert.strictEqual(tasks[1].status, undefined);
    } finally {
      try {
        rmSync(join(PROJECT_ROOT, 'runs', 'block', blockId), { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  });

  test('corrupt state in resume produces safe non-zero ok false output', () => {
    const repoPath = createTempRepo();
    const { blockPath, blockId } = createBlockFile(repoPath);

    const runsDir = join(PROJECT_ROOT, 'runs', 'block', blockId);
    mkdirSync(runsDir, { recursive: true });
    const statePath = join(runsDir, 'state.json');
    writeFileSync(statePath, 'not-json', 'utf-8');

    try {
      const result = runCli(['real-block-run-ai-dry-run', blockPath, '--resume'], buildEnv());
      assert.notStrictEqual(result.status, 0);
      const json = parseOutput(result.stdout);
      assert.strictEqual(json.ok, false);
      assert.ok(Array.isArray(json.readiness.reasons));
    } finally {
      try {
        rmSync(join(PROJECT_ROOT, 'runs', 'block', blockId), { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  });

  test('dry-run does not leak API key in output', () => {
    const repoPath = createTempRepo();
    const { blockPath } = createBlockFile(repoPath);
    const env = buildEnv({ KIMI_API_KEY: 'sk-real-secret-key-abcdef' });
    const result = runCli(['real-block-run-ai-dry-run', blockPath], env);
    const output = `${result.stdout}\n${result.stderr}`;
    assert.doesNotMatch(output, /sk-real-secret-key-abcdef/);
  });

  test('dry-run output redacts secret-like provider error', () => {
    const repoPath = createTempRepo();
    const { blockPath } = createBlockFile(repoPath);
    const result = runCli(['real-block-run-ai-dry-run', blockPath, '--provider', 'sk-real-secret-provider'], buildEnv());
    const output = `${result.stdout}\n${result.stderr}`;
    assert.doesNotMatch(output, /sk-real-secret-provider/);
  });

  test('dry-run source does not import provider client', () => {
    const source = readSource(SOURCE_PATH);
    assert.doesNotMatch(source, /from '\.\/kimi-client/);
    assert.doesNotMatch(source, /from '\.\/ai-client/);
  });

  test('CLI source does not use shell:true for dry-run branch', () => {
    const source = readFileSync(CLI_PATH, 'utf-8');
    const dryRunIndex = source.indexOf("command === 'real-block-run-ai-dry-run'");
    assert.ok(dryRunIndex >= 0, 'dry-run branch must exist in cli.ts');
    const nextBranchIndex = source.indexOf("command === 'real-provider-smoke'", dryRunIndex);
    const snippet = source.slice(dryRunIndex, nextBranchIndex);
    assert.doesNotMatch(snippet, /shell:\s*true/);
  });

  test('dry-run exposes readiness report', () => {
    const repoPath = createTempRepo();
    const { blockPath } = createBlockFile(repoPath);
    const result = runCli(['real-block-run-ai-dry-run', blockPath], buildEnv());
    const json = parseOutput(result.stdout);
    const readiness = json.readiness as Record<string, unknown>;
    assert.strictEqual(readiness.ready, true);
    assert.strictEqual(readiness.mode, 'fresh');
  });
});

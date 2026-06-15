import { describe, test } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { validateRealBlockFile, formatRealBlockValidateReport } from '../src/real-block-validate.js';

const PROJECT_ROOT = process.cwd();
const TSX_CLI_PATH = join(PROJECT_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const CLI_PATH = join(PROJECT_ROOT, 'src', 'cli.ts');
const SOURCE_PATH = join(PROJECT_ROOT, 'src', 'real-block-validate.ts');
const CLI_SOURCE_PATH = join(PROJECT_ROOT, 'src', 'cli.ts');

let counter = 0;

function runCli(
  args: string[],
  envOverrides: Record<string, string | undefined> = {}
): {
  status: number;
  stdout: string;
  stderr: string;
} {
  const env: Record<string, string | undefined> = { ...process.env };
  for (const [key, value] of Object.entries(envOverrides)) {
    if (value === undefined) {
      delete env[key];
    } else {
      env[key] = value;
    }
  }
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

function runCliWithoutKimi(args: string[]): {
  status: number;
  stdout: string;
  stderr: string;
} {
  return runCli(args, {
    KIMI_API_KEY: undefined,
    KIMI_BASE_URL: undefined,
    KIMI_MODEL: undefined,
    ALLOW_REAL_BLOCK_RUN_AI: undefined,
    ALLOW_REAL_PROVIDER: undefined,
    ALLOW_REAL_REPO_APPLY: undefined,
    ALLOW_REAL_REPO_COMMIT: undefined,
    ALLOW_REAL_REPO_PUSH: undefined,
  });
}

function createTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'block-validate-'));
}

function createBlockFile(
  dir: string,
  overrides: Record<string, unknown> = {}
): { blockPath: string; blockId: string } {
  counter += 1;
  const blockId = `block_validate_${Date.now()}_${counter}`;
  const blockPath = join(dir, `${blockId}.json`);
  const block = {
    block_id: blockId,
    title: 'Validate test block',
    repo_path: '.',
    base_branch: 'main',
    work_branch: 'ai-validate',
    providers: {
      coder: { provider: 'kimi', model: 'kimi-k2.6' },
      reviewer: { provider: 'kimi', model: 'kimi-k2.6' },
    },
    review_policy: {
      require_deterministic_checks: true,
      max_fix_attempts: 1,
      reviewer_mode: 'single',
    },
    tasks: [
      {
        task_id: 'task_1',
        title: 'First task',
        goal: 'Update the README safely.',
        allowed_files: ['README.md'],
        denied_files: ['package.json'],
        max_lines_changed: 100,
        checks: ['npm run typecheck'],
      },
    ],
    ...overrides,
  };
  writeFileSync(blockPath, JSON.stringify(block, null, 2), 'utf-8');
  return { blockPath, blockId };
}

function parseOutput(output: string): Record<string, unknown> {
  const match = output.match(/\{[\s\S]*\}/);
  assert.ok(match, 'output should contain JSON');
  return JSON.parse(match[0]) as Record<string, unknown>;
}

function readSource(path: string): string {
  return readFileSync(path, 'utf-8');
}

describe('real-block-validate CLI', () => {
  test('CLI usage includes real-block-validate', () => {
    const result = runCli([]);
    assert.notStrictEqual(result.status, 0);
    const output = `${result.stdout}\n${result.stderr}`;
    assert.match(output, /real-block-validate/);
  });

  test('missing block path exits non-zero', () => {
    const result = runCli(['real-block-validate']);
    assert.notStrictEqual(result.status, 0);
  });

  test('missing block path outputs parseable JSON', () => {
    const result = runCli(['real-block-validate']);
    const json = parseOutput(result.stdout);
    assert.strictEqual(json.ok, false);
    assert.strictEqual(json.mode, 'real-block-validate');
    assert.match(String(json.error), /path is required/i);
  });

  test('nonexistent block path exits non-zero', () => {
    const tmpDir = createTempDir();
    const result = runCli(['real-block-validate', join(tmpDir, 'missing.json')]);
    assert.notStrictEqual(result.status, 0);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('nonexistent block path outputs parseable JSON', () => {
    const tmpDir = createTempDir();
    const result = runCli(['real-block-validate', join(tmpDir, 'missing.json')]);
    const json = parseOutput(result.stdout);
    assert.strictEqual(json.ok, false);
    assert.match(String(json.error), /not found|Block definition/i);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('corrupt JSON exits non-zero', () => {
    const tmpDir = createTempDir();
    const blockPath = join(tmpDir, 'bad.json');
    writeFileSync(blockPath, 'not json', 'utf-8');
    const result = runCli(['real-block-validate', blockPath]);
    assert.notStrictEqual(result.status, 0);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('corrupt JSON outputs parseable JSON', () => {
    const tmpDir = createTempDir();
    const blockPath = join(tmpDir, 'bad.json');
    writeFileSync(blockPath, 'not json', 'utf-8');
    const result = runCli(['real-block-validate', blockPath]);
    const json = parseOutput(result.stdout);
    assert.strictEqual(json.ok, false);
    assert.match(String(json.error), /parse|JSON/i);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('invalid schema exits non-zero', () => {
    const tmpDir = createTempDir();
    const { blockPath } = createBlockFile(tmpDir);
    const block = JSON.parse(readFileSync(blockPath, 'utf-8'));
    delete block.block_id;
    writeFileSync(blockPath, JSON.stringify(block), 'utf-8');
    const result = runCli(['real-block-validate', blockPath]);
    assert.notStrictEqual(result.status, 0);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('invalid schema outputs parseable JSON', () => {
    const tmpDir = createTempDir();
    const { blockPath } = createBlockFile(tmpDir);
    const block = JSON.parse(readFileSync(blockPath, 'utf-8'));
    delete block.block_id;
    writeFileSync(blockPath, JSON.stringify(block), 'utf-8');
    const result = runCli(['real-block-validate', blockPath]);
    const json = parseOutput(result.stdout);
    assert.strictEqual(json.ok, false);
    assert.match(String(json.error), /block_id/i);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('valid block exits 0', () => {
    const tmpDir = createTempDir();
    const { blockPath } = createBlockFile(tmpDir);
    const result = runCliWithoutKimi(['real-block-validate', blockPath]);
    assert.strictEqual(result.status, 0, result.stderr);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('valid block output is JSON parseable', () => {
    const tmpDir = createTempDir();
    const { blockPath } = createBlockFile(tmpDir);
    const result = runCliWithoutKimi(['real-block-validate', blockPath]);
    const json = parseOutput(result.stdout);
    assert.strictEqual(typeof json.ok, 'boolean');
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('valid block output has ok true', () => {
    const tmpDir = createTempDir();
    const { blockPath } = createBlockFile(tmpDir);
    const result = runCliWithoutKimi(['real-block-validate', blockPath]);
    const json = parseOutput(result.stdout);
    assert.strictEqual(json.ok, true);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('valid block output has mode real-block-validate', () => {
    const tmpDir = createTempDir();
    const { blockPath } = createBlockFile(tmpDir);
    const result = runCliWithoutKimi(['real-block-validate', blockPath]);
    const json = parseOutput(result.stdout);
    assert.strictEqual(json.mode, 'real-block-validate');
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('valid block output includes block id', () => {
    const tmpDir = createTempDir();
    const { blockPath, blockId } = createBlockFile(tmpDir);
    const result = runCliWithoutKimi(['real-block-validate', blockPath]);
    const json = parseOutput(result.stdout);
    assert.strictEqual(json.blockId, blockId);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('valid block output includes title', () => {
    const tmpDir = createTempDir();
    const { blockPath } = createBlockFile(tmpDir);
    const result = runCliWithoutKimi(['real-block-validate', blockPath]);
    const json = parseOutput(result.stdout);
    assert.strictEqual(json.title, 'Validate test block');
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('valid block output includes repo path', () => {
    const tmpDir = createTempDir();
    const { blockPath } = createBlockFile(tmpDir);
    const result = runCliWithoutKimi(['real-block-validate', blockPath]);
    const json = parseOutput(result.stdout);
    assert.strictEqual(json.repoPath, '.');
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('valid block output includes base branch', () => {
    const tmpDir = createTempDir();
    const { blockPath } = createBlockFile(tmpDir);
    const result = runCliWithoutKimi(['real-block-validate', blockPath]);
    const json = parseOutput(result.stdout);
    assert.strictEqual(json.baseBranch, 'main');
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('valid block output includes work branch', () => {
    const tmpDir = createTempDir();
    const { blockPath } = createBlockFile(tmpDir);
    const result = runCliWithoutKimi(['real-block-validate', blockPath]);
    const json = parseOutput(result.stdout);
    assert.strictEqual(json.workBranch, 'ai-validate');
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('valid block output includes task count', () => {
    const tmpDir = createTempDir();
    const { blockPath } = createBlockFile(tmpDir);
    const result = runCliWithoutKimi(['real-block-validate', blockPath]);
    const json = parseOutput(result.stdout);
    assert.strictEqual(json.taskCount, 1);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('valid block output includes ordered tasks', () => {
    const tmpDir = createTempDir();
    const { blockPath } = createBlockFile(tmpDir, {
      tasks: [
        {
          task_id: 'task_a',
          title: 'A',
          goal: 'Do A.',
          allowed_files: ['a.md'],
          denied_files: [],
          max_lines_changed: 10,
          checks: ['echo a'],
        },
        {
          task_id: 'task_b',
          title: 'B',
          goal: 'Do B.',
          allowed_files: ['b.md'],
          denied_files: [],
          max_lines_changed: 10,
          checks: ['echo b'],
        },
      ],
    });
    const result = runCliWithoutKimi(['real-block-validate', blockPath]);
    const json = parseOutput(result.stdout);
    const tasks = json.tasks as Array<Record<string, unknown>>;
    assert.ok(Array.isArray(tasks));
    assert.strictEqual(tasks.length, 2);
    assert.strictEqual(tasks[0].task_id, 'task_a');
    assert.strictEqual(tasks[1].task_id, 'task_b');
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('valid block output includes allowed_files', () => {
    const tmpDir = createTempDir();
    const { blockPath } = createBlockFile(tmpDir);
    const result = runCliWithoutKimi(['real-block-validate', blockPath]);
    const json = parseOutput(result.stdout);
    const tasks = json.tasks as Array<Record<string, unknown>>;
    assert.deepStrictEqual(tasks[0].allowed_files, ['README.md']);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('valid block output includes denied_files', () => {
    const tmpDir = createTempDir();
    const { blockPath } = createBlockFile(tmpDir);
    const result = runCliWithoutKimi(['real-block-validate', blockPath]);
    const json = parseOutput(result.stdout);
    const tasks = json.tasks as Array<Record<string, unknown>>;
    assert.deepStrictEqual(tasks[0].denied_files, ['package.json']);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('valid block output includes checks', () => {
    const tmpDir = createTempDir();
    const { blockPath } = createBlockFile(tmpDir);
    const result = runCliWithoutKimi(['real-block-validate', blockPath]);
    const json = parseOutput(result.stdout);
    const tasks = json.tasks as Array<Record<string, unknown>>;
    assert.deepStrictEqual(tasks[0].checks, ['npm run typecheck']);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('valid block output includes max_lines_changed', () => {
    const tmpDir = createTempDir();
    const { blockPath } = createBlockFile(tmpDir);
    const result = runCliWithoutKimi(['real-block-validate', blockPath]);
    const json = parseOutput(result.stdout);
    const tasks = json.tasks as Array<Record<string, unknown>>;
    assert.strictEqual(tasks[0].max_lines_changed, 100);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('output includes next checklist command', () => {
    const tmpDir = createTempDir();
    const { blockPath } = createBlockFile(tmpDir);
    const result = runCliWithoutKimi(['real-block-validate', blockPath]);
    const json = parseOutput(result.stdout);
    const commands = json.nextCommands as string[];
    assert.ok(commands.some((c) => c.includes('real-block-run-ai-checklist')));
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('output includes next dry-run command', () => {
    const tmpDir = createTempDir();
    const { blockPath } = createBlockFile(tmpDir);
    const result = runCliWithoutKimi(['real-block-validate', blockPath]);
    const json = parseOutput(result.stdout);
    const commands = json.nextCommands as string[];
    assert.ok(commands.some((c) => c.includes('real-block-run-ai-dry-run')));
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('empty allowed_files produces warning', () => {
    const tmpDir = createTempDir();
    const { blockPath } = createBlockFile(tmpDir, {
      tasks: [
        {
          task_id: 'task_1',
          title: 'First task',
          goal: 'Do thing.',
          allowed_files: [],
          denied_files: [],
          max_lines_changed: 100,
          checks: ['npm run typecheck'],
        },
      ],
    });
    const result = runCliWithoutKimi(['real-block-validate', blockPath]);
    const json = parseOutput(result.stdout);
    assert.strictEqual(result.status, 0, result.stderr);
    assert.strictEqual(json.ok, true);
    const warnings = json.warnings as string[];
    assert.ok(warnings.some((w) => /empty allowed_files/i.test(w)));
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('empty checks produces warning', () => {
    const tmpDir = createTempDir();
    const { blockPath } = createBlockFile(tmpDir, {
      tasks: [
        {
          task_id: 'task_1',
          title: 'First task',
          goal: 'Do thing.',
          allowed_files: ['README.md'],
          denied_files: [],
          max_lines_changed: 100,
          checks: [],
        },
      ],
    });
    const result = runCliWithoutKimi(['real-block-validate', blockPath]);
    const json = parseOutput(result.stdout);
    assert.strictEqual(result.status, 0, result.stderr);
    assert.strictEqual(json.ok, true);
    const warnings = json.warnings as string[];
    assert.ok(warnings.some((w) => /empty checks/i.test(w)));
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('placeholder goal produces warning', () => {
    const tmpDir = createTempDir();
    const { blockPath } = createBlockFile(tmpDir, {
      tasks: [
        {
          task_id: 'task_1',
          title: 'First task',
          goal: 'Edit this goal to describe what the task should accomplish.',
          allowed_files: ['README.md'],
          denied_files: [],
          max_lines_changed: 100,
          checks: ['npm run typecheck'],
        },
      ],
    });
    const result = runCliWithoutKimi(['real-block-validate', blockPath]);
    const json = parseOutput(result.stdout);
    assert.strictEqual(result.status, 0, result.stderr);
    assert.strictEqual(json.ok, true);
    const warnings = json.warnings as string[];
    assert.ok(warnings.some((w) => /placeholder/i.test(w)));
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('non-ai work branch produces warning', () => {
    const tmpDir = createTempDir();
    const { blockPath } = createBlockFile(tmpDir, { work_branch: 'feature-x' });
    const result = runCliWithoutKimi(['real-block-validate', blockPath]);
    const json = parseOutput(result.stdout);
    assert.strictEqual(result.status, 0, result.stderr);
    assert.strictEqual(json.ok, true);
    const warnings = json.warnings as string[];
    assert.ok(warnings.some((w) => /does not start with "ai-"/i.test(w)));
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('warning-only cases still exit 0', () => {
    const tmpDir = createTempDir();
    const { blockPath } = createBlockFile(tmpDir, {
      work_branch: 'feature-x',
      tasks: [
        {
          task_id: 'task_1',
          title: 'First task',
          goal: 'Edit this goal to describe what the task should accomplish.',
          allowed_files: [],
          denied_files: [],
          max_lines_changed: 100,
          checks: [],
        },
      ],
    });
    const result = runCliWithoutKimi(['real-block-validate', blockPath]);
    const json = parseOutput(result.stdout);
    assert.strictEqual(result.status, 0, result.stderr);
    assert.strictEqual(json.ok, true);
    const warnings = json.warnings as string[];
    assert.ok(warnings.length >= 3, `expected multiple warnings, got ${warnings.join(', ')}`);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('CLI usage documents real-block-validate --strict', () => {
    const result = runCli([]);
    const output = `${result.stdout}\n${result.stderr}`;
    assert.match(output, /real-block-validate/);
    assert.match(output, /--strict/);
  });

  test('strict warning-only block exits non-zero', () => {
    const tmpDir = createTempDir();
    const { blockPath } = createBlockFile(tmpDir, {
      tasks: [
        {
          task_id: 'task_1',
          title: 'First task',
          goal: 'Do thing.',
          allowed_files: ['README.md'],
          denied_files: [],
          max_lines_changed: 100,
          checks: [],
        },
      ],
    });
    const result = runCliWithoutKimi(['real-block-validate', blockPath, '--strict']);
    assert.notStrictEqual(result.status, 0);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('strict warning-only output has ok false', () => {
    const tmpDir = createTempDir();
    const { blockPath } = createBlockFile(tmpDir, {
      tasks: [
        {
          task_id: 'task_1',
          title: 'First task',
          goal: 'Do thing.',
          allowed_files: ['README.md'],
          denied_files: [],
          max_lines_changed: 100,
          checks: [],
        },
      ],
    });
    const result = runCliWithoutKimi(['real-block-validate', blockPath, '--strict']);
    const json = parseOutput(result.stdout);
    assert.strictEqual(json.ok, false);
    assert.strictEqual(json.strict, true);
    assert.strictEqual(json.warningsAsErrors, true);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('strict warning-only output includes original warnings', () => {
    const tmpDir = createTempDir();
    const { blockPath } = createBlockFile(tmpDir, {
      tasks: [
        {
          task_id: 'task_1',
          title: 'First task',
          goal: 'Do thing.',
          allowed_files: ['README.md'],
          denied_files: [],
          max_lines_changed: 100,
          checks: [],
        },
      ],
    });
    const result = runCliWithoutKimi(['real-block-validate', blockPath, '--strict']);
    const json = parseOutput(result.stdout);
    const warnings = json.warnings as string[];
    assert.ok(warnings.some((w) => /empty checks/i.test(w)));
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('strict warning-only output includes deterministic reason', () => {
    const tmpDir = createTempDir();
    const { blockPath } = createBlockFile(tmpDir, {
      tasks: [
        {
          task_id: 'task_1',
          title: 'First task',
          goal: 'Do thing.',
          allowed_files: ['README.md'],
          denied_files: [],
          max_lines_changed: 100,
          checks: [],
        },
      ],
    });
    const result = runCliWithoutKimi(['real-block-validate', blockPath, '--strict']);
    const json = parseOutput(result.stdout);
    const reasons = json.reasons as string[];
    assert.ok(reasons.some((r) => /Strict validation failed/i.test(r)));
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('strict warning-only output has empty nextCommands', () => {
    const tmpDir = createTempDir();
    const { blockPath } = createBlockFile(tmpDir, {
      tasks: [
        {
          task_id: 'task_1',
          title: 'First task',
          goal: 'Do thing.',
          allowed_files: ['README.md'],
          denied_files: [],
          max_lines_changed: 100,
          checks: [],
        },
      ],
    });
    const result = runCliWithoutKimi(['real-block-validate', blockPath, '--strict']);
    const json = parseOutput(result.stdout);
    assert.deepStrictEqual(json.nextCommands, []);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('strict valid block exits 0', () => {
    const tmpDir = createTempDir();
    const { blockPath } = createBlockFile(tmpDir);
    const result = runCliWithoutKimi(['real-block-validate', blockPath, '--strict']);
    assert.strictEqual(result.status, 0, result.stderr);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('strict valid block output has ok true and strict true', () => {
    const tmpDir = createTempDir();
    const { blockPath } = createBlockFile(tmpDir);
    const result = runCliWithoutKimi(['real-block-validate', blockPath, '--strict']);
    const json = parseOutput(result.stdout);
    assert.strictEqual(json.ok, true);
    assert.strictEqual(json.strict, true);
    assert.strictEqual(json.warningsAsErrors, undefined);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('structural invalid block exits non-zero in strict mode', () => {
    const tmpDir = createTempDir();
    const { blockPath } = createBlockFile(tmpDir);
    const block = JSON.parse(readFileSync(blockPath, 'utf-8'));
    delete block.block_id;
    writeFileSync(blockPath, JSON.stringify(block), 'utf-8');
    const result = runCliWithoutKimi(['real-block-validate', blockPath, '--strict']);
    assert.notStrictEqual(result.status, 0);
    const json = parseOutput(result.stdout);
    assert.strictEqual(json.ok, false);
    assert.strictEqual(json.strict, true);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('placeholder goal warning becomes strict failure', () => {
    const tmpDir = createTempDir();
    const { blockPath } = createBlockFile(tmpDir, {
      tasks: [
        {
          task_id: 'task_1',
          title: 'First task',
          goal: 'Edit this goal to describe what the task should accomplish.',
          allowed_files: ['README.md'],
          denied_files: [],
          max_lines_changed: 100,
          checks: ['npm run typecheck'],
        },
      ],
    });
    const result = runCliWithoutKimi(['real-block-validate', blockPath, '--strict']);
    const json = parseOutput(result.stdout);
    assert.notStrictEqual(result.status, 0);
    assert.strictEqual(json.ok, false);
    assert.strictEqual(json.warningsAsErrors, true);
    const warnings = json.warnings as string[];
    assert.ok(warnings.some((w) => /placeholder/i.test(w)));
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('empty allowed_files warning becomes strict failure', () => {
    const tmpDir = createTempDir();
    const { blockPath } = createBlockFile(tmpDir, {
      tasks: [
        {
          task_id: 'task_1',
          title: 'First task',
          goal: 'Do thing.',
          allowed_files: [],
          denied_files: [],
          max_lines_changed: 100,
          checks: ['npm run typecheck'],
        },
      ],
    });
    const result = runCliWithoutKimi(['real-block-validate', blockPath, '--strict']);
    const json = parseOutput(result.stdout);
    assert.notStrictEqual(result.status, 0);
    assert.strictEqual(json.ok, false);
    assert.strictEqual(json.warningsAsErrors, true);
    const warnings = json.warnings as string[];
    assert.ok(warnings.some((w) => /empty allowed_files/i.test(w)));
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('non-ai work branch warning becomes strict failure', () => {
    const tmpDir = createTempDir();
    const { blockPath } = createBlockFile(tmpDir, { work_branch: 'feature-x' });
    const result = runCliWithoutKimi(['real-block-validate', blockPath, '--strict']);
    const json = parseOutput(result.stdout);
    assert.notStrictEqual(result.status, 0);
    assert.strictEqual(json.ok, false);
    assert.strictEqual(json.warningsAsErrors, true);
    const warnings = json.warnings as string[];
    assert.ok(warnings.some((w) => /does not start with "ai-"/i.test(w)));
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('strict failure preserves multiple warnings', () => {
    const tmpDir = createTempDir();
    const { blockPath } = createBlockFile(tmpDir, {
      work_branch: 'feature-x',
      tasks: [
        {
          task_id: 'task_1',
          title: 'First task',
          goal: 'Edit this goal to describe what the task should accomplish.',
          allowed_files: [],
          denied_files: [],
          max_lines_changed: 100,
          checks: [],
        },
      ],
    });
    const result = runCliWithoutKimi(['real-block-validate', blockPath, '--strict']);
    const json = parseOutput(result.stdout);
    assert.strictEqual(json.ok, false);
    const warnings = json.warnings as string[];
    assert.ok(warnings.length >= 3, `expected multiple warnings, got ${warnings.join(', ')}`);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('secret-like strings in title/goal are redacted in strict failure', () => {
    const tmpDir = createTempDir();
    const { blockPath } = createBlockFile(tmpDir, {
      title: 'My block sk-secret123456',
      tasks: [
        {
          task_id: 'task_1',
          title: 'First task',
          goal: 'Do pk-secret789 thing.',
          allowed_files: ['README.md'],
          denied_files: [],
          max_lines_changed: 100,
          checks: [],
        },
      ],
    });
    const result = runCliWithoutKimi(['real-block-validate', blockPath, '--strict']);
    const output = `${result.stdout}\n${result.stderr}`;
    assert.notStrictEqual(result.status, 0);
    assert.doesNotMatch(output, /sk-secret123456/);
    assert.doesNotMatch(output, /pk-secret789/);
    assert.match(output, /\[REDACTED\]/);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('unsafe block id fails through loader', () => {
    const tmpDir = createTempDir();
    const { blockPath } = createBlockFile(tmpDir, { block_id: '../evil' });
    const result = runCliWithoutKimi(['real-block-validate', blockPath]);
    const json = parseOutput(result.stdout);
    assert.notStrictEqual(result.status, 0);
    assert.strictEqual(json.ok, false);
    assert.match(String(json.error), /unsupported characters/i);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('unsafe task id fails through loader', () => {
    const tmpDir = createTempDir();
    const { blockPath } = createBlockFile(tmpDir, {
      tasks: [
        {
          task_id: 'task evil',
          title: 'Bad task',
          goal: 'Do thing.',
          allowed_files: ['README.md'],
          denied_files: [],
          max_lines_changed: 100,
          checks: ['npm run typecheck'],
        },
      ],
    });
    const result = runCliWithoutKimi(['real-block-validate', blockPath]);
    const json = parseOutput(result.stdout);
    assert.notStrictEqual(result.status, 0);
    assert.strictEqual(json.ok, false);
    assert.match(String(json.error), /unsupported characters/i);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('failure output is redacted', () => {
    const secret = 'sk-secret123456';
    const result = runCliWithoutKimi(['real-block-validate', `missing/${secret}/block.json`]);
    const output = `${result.stdout}\n${result.stderr}`;
    assert.notStrictEqual(result.status, 0);
    assert.doesNotMatch(output, new RegExp(secret));
    assert.match(output, /\[REDACTED\]/);
  });

  test('secret-like strings in title and goal are redacted', () => {
    const tmpDir = createTempDir();
    const { blockPath, blockId } = createBlockFile(tmpDir, {
      title: 'My block sk-secret123456',
      tasks: [
        {
          task_id: 'task_1',
          title: 'First task',
          goal: 'Do pk-secret789 thing.',
          allowed_files: ['README.md'],
          denied_files: [],
          max_lines_changed: 100,
          checks: ['npm run typecheck'],
        },
      ],
    });
    const result = runCliWithoutKimi(['real-block-validate', blockPath]);
    const output = `${result.stdout}\n${result.stderr}`;
    assert.strictEqual(result.status, 0, result.stderr);
    assert.doesNotMatch(output, /sk-secret123456/);
    assert.doesNotMatch(output, /pk-secret789/);
    assert.match(output, /\[REDACTED\]/);
    assert.strictEqual(existsSync(join(PROJECT_ROOT, 'runs', 'block', blockId)), false);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('command does not require KIMI env', () => {
    const tmpDir = createTempDir();
    const { blockPath } = createBlockFile(tmpDir);
    const result = runCliWithoutKimi(['real-block-validate', blockPath]);
    assert.strictEqual(result.status, 0, result.stderr);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('command does not call provider', () => {
    const source = readSource(SOURCE_PATH);
    assert.doesNotMatch(source, /createKimiClient/);
    assert.doesNotMatch(source, /runRealProviderSmoke/);
    assert.doesNotMatch(source, /createAIClient/);
  });

  test('command does not call network/fetch/http', () => {
    const source = readSource(SOURCE_PATH);
    assert.doesNotMatch(source, /\bfetch\s*\(/);
    assert.doesNotMatch(source, /globalThis\.fetch/);
    assert.doesNotMatch(source, /http\.request/);
    assert.doesNotMatch(source, /https\.request/);
  });

  test('command does not run git', () => {
    const source = readSource(SOURCE_PATH);
    assert.doesNotMatch(source, /spawnSync\('git'/);
    assert.doesNotMatch(source, /git.*commit/);
    assert.doesNotMatch(source, /git.*push/);
  });

  test('command does not write state', () => {
    const tmpDir = createTempDir();
    const { blockPath, blockId } = createBlockFile(tmpDir);
    runCliWithoutKimi(['real-block-validate', blockPath]);
    assert.strictEqual(existsSync(join(PROJECT_ROOT, 'runs', 'block', blockId)), false);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('command does not spawn block runner', () => {
    const source = readSource(SOURCE_PATH);
    assert.doesNotMatch(source, /runRealBlockRunAI/);
    assert.doesNotMatch(source, /runOneTaskLoop/);
    assert.doesNotMatch(source, /runMultiTaskLoop/);
    assert.doesNotMatch(source, /runMultiTaskFakeLoop/);
  });

  test('command source does not use shell:true', () => {
    const source = readSource(SOURCE_PATH);
    assert.doesNotMatch(source, /shell:\s*true/);
  });

  test('CLI source wires real-block-validate branch without shell:true', () => {
    const source = readFileSync(CLI_SOURCE_PATH, 'utf-8');
    const branchIndex = source.indexOf("command === 'real-block-validate'");
    assert.ok(branchIndex >= 0, 'validate branch must exist in cli.ts');
    const nextBranchIndex = source.indexOf("command === 'real-provider-smoke'", branchIndex);
    const snippet = source.slice(branchIndex, nextBranchIndex);
    assert.doesNotMatch(snippet, /shell:\s*true/);
  });

  test('module export validateRealBlockFile works directly', () => {
    const tmpDir = createTempDir();
    const { blockPath, blockId } = createBlockFile(tmpDir);
    const report = validateRealBlockFile(blockPath);
    assert.strictEqual(report.ok, true);
    assert.strictEqual(report.mode, 'real-block-validate');
    assert.strictEqual(report.blockId, blockId);
    assert.strictEqual(report.taskCount, 1);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('formatRealBlockValidateReport returns redacted parseable JSON', () => {
    const report = validateRealBlockFile('');
    const formatted = formatRealBlockValidateReport(report);
    const parsed = JSON.parse(formatted);
    assert.strictEqual(parsed.ok, false);
    assert.strictEqual(parsed.mode, 'real-block-validate');
  });

  test('tests do not call real AI providers', () => {
    const source = readFileSync(fileURLToPath(import.meta.url), 'utf-8');
    assert.doesNotMatch(source, /createKimiClient\(/);
    assert.doesNotMatch(source, /createAIClient\(/);
    assert.doesNotMatch(source, /runRealProviderSmoke\(/);
  });

  test('tests do not make network calls', () => {
    const source = readFileSync(fileURLToPath(import.meta.url), 'utf-8');
    assert.doesNotMatch(source, /\bfetch\s*\(/);
    assert.doesNotMatch(source, /globalThis\.fetch\s*\(/);
    assert.doesNotMatch(source, /http\.request\(/);
    assert.doesNotMatch(source, /https\.request\(/);
  });
});

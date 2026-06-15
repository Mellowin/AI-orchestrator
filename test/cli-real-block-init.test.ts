import { describe, test } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadBlockDefinition } from '../src/block/block-loader.js';
import { createRealBlockInitFile } from '../src/real-block-init.js';

const PROJECT_ROOT = process.cwd();
const TSX_CLI_PATH = join(PROJECT_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const CLI_PATH = join(PROJECT_ROOT, 'src', 'cli.ts');
const SOURCE_PATH = join(PROJECT_ROOT, 'src', 'real-block-init.ts');
const CLI_SOURCE_PATH = join(PROJECT_ROOT, 'src', 'cli.ts');

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

function createTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'block-init-test-'));
}

function parseOutput(output: string): Record<string, unknown> {
  const match = output.match(/\{[\s\S]*\}/);
  assert.ok(match, 'output should contain JSON');
  return JSON.parse(match[0]) as Record<string, unknown>;
}

function readSource(path: string): string {
  return readFileSync(path, 'utf-8');
}

describe('real-block-init CLI', () => {
  test('CLI usage includes real-block-init', () => {
    const result = runCli([]);
    assert.notStrictEqual(result.status, 0);
    const output = `${result.stdout}\n${result.stderr}`;
    assert.match(output, /real-block-init/);
  });

  test('missing output path exits non-zero', () => {
    const result = runCli(['real-block-init']);
    assert.notStrictEqual(result.status, 0);
    const output = `${result.stdout}\n${result.stderr}`;
    assert.match(output, /output path is required/i);
  });

  test('output path must end with .json', () => {
    const tmpDir = createTempDir();
    const result = runCli(['real-block-init', join(tmpDir, 'block.txt')]);
    assert.notStrictEqual(result.status, 0);
    const json = parseOutput(result.stdout);
    assert.strictEqual(json.ok, false);
    assert.match(String(json.error), /\.json/i);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('parent directory must exist', () => {
    const tmpDir = createTempDir();
    const missingDir = join(tmpDir, 'missing');
    const result = runCli(['real-block-init', join(missingDir, 'block.json')]);
    assert.notStrictEqual(result.status, 0);
    const json = parseOutput(result.stdout);
    assert.strictEqual(json.ok, false);
    assert.match(String(json.error), /Parent directory/i);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('existing output file without --force exits non-zero', () => {
    const tmpDir = createTempDir();
    const outputPath = join(tmpDir, 'block.json');
    writeFileSync(outputPath, '{}', 'utf-8');
    const result = runCli(['real-block-init', outputPath]);
    assert.notStrictEqual(result.status, 0);
    const json = parseOutput(result.stdout);
    assert.strictEqual(json.ok, false);
    assert.match(String(json.error), /already exists/i);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('existing output file with --force overwrites', () => {
    const tmpDir = createTempDir();
    const outputPath = join(tmpDir, 'block.json');
    writeFileSync(outputPath, '{}', 'utf-8');
    const result = runCli(['real-block-init', outputPath, '--force']);
    assert.strictEqual(result.status, 0, result.stderr);
    const json = parseOutput(result.stdout);
    assert.strictEqual(json.ok, true);
    const block = JSON.parse(readFileSync(outputPath, 'utf-8'));
    assert.strictEqual(block.block_id, 'my_block');
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('default command writes valid block JSON', () => {
    const tmpDir = createTempDir();
    const outputPath = join(tmpDir, 'block.json');
    const result = runCli(['real-block-init', outputPath]);
    assert.strictEqual(result.status, 0, result.stderr);
    assert.ok(existsSync(outputPath));
    const block = JSON.parse(readFileSync(outputPath, 'utf-8'));
    assert.strictEqual(block.block_id, 'my_block');
    assert.strictEqual(block.title, 'My AI block');
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('generated block loads with loadBlockDefinition', () => {
    const tmpDir = createTempDir();
    const outputPath = join(tmpDir, 'block.json');
    runCli(['real-block-init', outputPath]);
    const loaded = loadBlockDefinition(outputPath);
    assert.strictEqual(loaded.block_id, 'my_block');
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('generated block has safe default block_id', () => {
    const tmpDir = createTempDir();
    const outputPath = join(tmpDir, 'block.json');
    runCli(['real-block-init', outputPath]);
    const block = JSON.parse(readFileSync(outputPath, 'utf-8'));
    assert.strictEqual(block.block_id, 'my_block');
    assert.match(block.block_id, /^[A-Za-z0-9_-]+$/);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('generated block has safe default task_id', () => {
    const tmpDir = createTempDir();
    const outputPath = join(tmpDir, 'block.json');
    runCli(['real-block-init', outputPath]);
    const block = JSON.parse(readFileSync(outputPath, 'utf-8'));
    assert.strictEqual(block.tasks[0].task_id, 'task_1');
    assert.match(block.tasks[0].task_id, /^[A-Za-z0-9_-]+$/);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('custom --block-id is used', () => {
    const tmpDir = createTempDir();
    const outputPath = join(tmpDir, 'block.json');
    const result = runCli(['real-block-init', outputPath, '--block-id', 'my_custom_block']);
    assert.strictEqual(result.status, 0, result.stderr);
    const block = JSON.parse(readFileSync(outputPath, 'utf-8'));
    assert.strictEqual(block.block_id, 'my_custom_block');
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('unsafe --block-id exits non-zero', () => {
    const tmpDir = createTempDir();
    const outputPath = join(tmpDir, 'block.json');
    const result = runCli(['real-block-init', outputPath, '--block-id', 'block/../unsafe']);
    assert.notStrictEqual(result.status, 0);
    const json = parseOutput(result.stdout);
    assert.strictEqual(json.ok, false);
    assert.match(String(json.error), /block_id/i);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('custom --task-id is used', () => {
    const tmpDir = createTempDir();
    const outputPath = join(tmpDir, 'block.json');
    const result = runCli(['real-block-init', outputPath, '--task-id', 'custom_task']);
    assert.strictEqual(result.status, 0, result.stderr);
    const block = JSON.parse(readFileSync(outputPath, 'utf-8'));
    assert.strictEqual(block.tasks[0].task_id, 'custom_task');
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('unsafe --task-id exits non-zero', () => {
    const tmpDir = createTempDir();
    const outputPath = join(tmpDir, 'block.json');
    const result = runCli(['real-block-init', outputPath, '--task-id', 'task with spaces']);
    assert.notStrictEqual(result.status, 0);
    const json = parseOutput(result.stdout);
    assert.strictEqual(json.ok, false);
    assert.match(String(json.error), /task_id/i);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('custom title/repo/base/work/task-title are used', () => {
    const tmpDir = createTempDir();
    const outputPath = join(tmpDir, 'block.json');
    const result = runCli([
      'real-block-init',
      outputPath,
      '--title',
      'Custom title',
      '--repo-path',
      './repo',
      '--base-branch',
      'develop',
      '--work-branch',
      'ai-custom',
      '--task-title',
      'Custom task',
    ]);
    assert.strictEqual(result.status, 0, result.stderr);
    const block = JSON.parse(readFileSync(outputPath, 'utf-8'));
    assert.strictEqual(block.title, 'Custom title');
    assert.strictEqual(block.repo_path, './repo');
    assert.strictEqual(block.base_branch, 'develop');
    assert.strictEqual(block.work_branch, 'ai-custom');
    assert.strictEqual(block.tasks[0].title, 'Custom task');
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('default providers are kimi', () => {
    const tmpDir = createTempDir();
    const outputPath = join(tmpDir, 'block.json');
    runCli(['real-block-init', outputPath]);
    const block = JSON.parse(readFileSync(outputPath, 'utf-8'));
    assert.strictEqual(block.providers.coder.provider, 'kimi');
    assert.strictEqual(block.providers.reviewer.provider, 'kimi');
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('default model is kimi-k2.6', () => {
    const tmpDir = createTempDir();
    const outputPath = join(tmpDir, 'block.json');
    runCli(['real-block-init', outputPath]);
    const block = JSON.parse(readFileSync(outputPath, 'utf-8'));
    assert.strictEqual(block.providers.coder.model, 'kimi-k2.6');
    assert.strictEqual(block.providers.reviewer.model, 'kimi-k2.6');
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('default review policy has max_fix_attempts 1', () => {
    const tmpDir = createTempDir();
    const outputPath = join(tmpDir, 'block.json');
    runCli(['real-block-init', outputPath]);
    const block = JSON.parse(readFileSync(outputPath, 'utf-8'));
    assert.strictEqual(block.review_policy.max_fix_attempts, 1);
    assert.strictEqual(block.review_policy.require_deterministic_checks, true);
    assert.strictEqual(block.review_policy.reviewer_mode, 'single');
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('default task includes allowed_files', () => {
    const tmpDir = createTempDir();
    const outputPath = join(tmpDir, 'block.json');
    runCli(['real-block-init', outputPath]);
    const block = JSON.parse(readFileSync(outputPath, 'utf-8'));
    assert.deepStrictEqual(block.tasks[0].allowed_files, ['README.md']);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('default task includes checks', () => {
    const tmpDir = createTempDir();
    const outputPath = join(tmpDir, 'block.json');
    runCli(['real-block-init', outputPath]);
    const block = JSON.parse(readFileSync(outputPath, 'utf-8'));
    assert.deepStrictEqual(block.tasks[0].checks, ['npm run typecheck']);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('JSON report is parseable', () => {
    const tmpDir = createTempDir();
    const outputPath = join(tmpDir, 'block.json');
    const result = runCli(['real-block-init', outputPath]);
    const json = parseOutput(result.stdout);
    assert.strictEqual(json.ok, true);
    assert.strictEqual(json.mode, 'real-block-init');
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('JSON report includes next checklist command', () => {
    const tmpDir = createTempDir();
    const outputPath = join(tmpDir, 'block.json');
    const result = runCli(['real-block-init', outputPath]);
    const json = parseOutput(result.stdout);
    const commands = json.nextCommands as string[];
    assert.ok(commands.some((c) => c.includes('real-block-run-ai-checklist')));
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('JSON report includes next dry-run command', () => {
    const tmpDir = createTempDir();
    const outputPath = join(tmpDir, 'block.json');
    const result = runCli(['real-block-init', outputPath]);
    const json = parseOutput(result.stdout);
    const commands = json.nextCommands as string[];
    assert.ok(commands.some((c) => c.includes('real-block-run-ai-dry-run')));
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

  test('command does not write runs/block state', () => {
    const tmpDir = createTempDir();
    const outputPath = join(tmpDir, 'block.json');
    runCli(['real-block-init', outputPath, '--block-id', 'init_state_test']);
    assert.strictEqual(existsSync(join(PROJECT_ROOT, 'runs', 'block', 'init_state_test')), false);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('command does not spawn block runner', () => {
    const source = readSource(SOURCE_PATH);
    assert.doesNotMatch(source, /runRealBlockRunAI/);
    assert.doesNotMatch(source, /runOneTaskLoop/);
    assert.doesNotMatch(source, /runMultiTaskLoop/);
  });

  test('command source does not use shell:true', () => {
    const source = readSource(SOURCE_PATH);
    assert.doesNotMatch(source, /shell:\s*true/);
  });

  test('CLI source does not use shell:true for init branch', () => {
    const source = readFileSync(CLI_SOURCE_PATH, 'utf-8');
    const initIndex = source.indexOf("command === 'real-block-init'");
    assert.ok(initIndex >= 0, 'init branch must exist in cli.ts');
    const nextBranchIndex = source.indexOf("command === 'real-provider-smoke'", initIndex);
    const snippet = source.slice(initIndex, nextBranchIndex);
    assert.doesNotMatch(snippet, /shell:\s*true/);
  });

  test('output does not contain secrets', () => {
    const tmpDir = createTempDir();
    const outputPath = join(tmpDir, 'block.json');
    const result = runCli(['real-block-init', outputPath]);
    const output = `${result.stdout}\n${result.stderr}`;
    assert.doesNotMatch(output, /sk-[a-zA-Z0-9]{16,}/);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('module export createRealBlockInitFile works directly', () => {
    const tmpDir = createTempDir();
    const outputPath = join(tmpDir, 'block.json');
    const report = createRealBlockInitFile(outputPath);
    assert.strictEqual(report.ok, true);
    assert.strictEqual(report.mode, 'real-block-init');
    assert.strictEqual(report.blockId, 'my_block');
    assert.strictEqual(report.taskCount, 1);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('work_branch main is rejected', () => {
    const tmpDir = createTempDir();
    const outputPath = join(tmpDir, 'block.json');
    const result = runCli(['real-block-init', outputPath, '--work-branch', 'main']);
    assert.notStrictEqual(result.status, 0);
    const json = parseOutput(result.stdout);
    assert.strictEqual(json.ok, false);
    assert.match(String(json.error), /main/i);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('work_branch equal base_branch is rejected', () => {
    const tmpDir = createTempDir();
    const outputPath = join(tmpDir, 'block.json');
    const result = runCli(['real-block-init', outputPath, '--base-branch', 'develop', '--work-branch', 'develop']);
    assert.notStrictEqual(result.status, 0);
    const json = parseOutput(result.stdout);
    assert.strictEqual(json.ok, false);
    assert.match(String(json.error), /work_branch must not equal base_branch/i);
    rmSync(tmpDir, { recursive: true, force: true });
  });
});

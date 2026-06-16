import { describe, test } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { checkRealBlockRunAIChecklist, checkProviderSmokeReadiness } from '../src/real-block-run-ai-checklist.js';

const PROJECT_ROOT = process.cwd();
const TSX_CLI_PATH = join(PROJECT_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const CLI_PATH = join(PROJECT_ROOT, 'src', 'cli.ts');
const SOURCE_PATH = join(PROJECT_ROOT, 'src', 'real-block-run-ai-checklist.ts');

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
  const tmpDir = mkdtempSync(join(tmpdir(), 'checklist-test-'));
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

function createBlockFile(repoPath: string): string {
  const tmpDir = mkdtempSync(join(tmpdir(), 'checklist-block-'));
  const blockPath = join(tmpDir, 'block.json');
  const block = {
    block_id: 'block_checklist',
    title: 'Checklist test block',
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
        denied_files: [],
        max_lines_changed: 100,
        checks: [],
      },
    ],
  };
  writeFileSync(blockPath, JSON.stringify(block, null, 2), 'utf-8');
  return blockPath;
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

function parseOutput(output: string): unknown {
  const match = output.match(/\{[\s\S]*\}/);
  assert.ok(match, 'output should contain JSON');
  return JSON.parse(match[0]);
}

describe('real-block-run-ai-checklist CLI', () => {
  test('CLI usage includes real-block-run-ai-checklist', () => {
    const result = runCli([]);
    assert.notStrictEqual(result.status, 0);
    const output = `${result.stdout}\n${result.stderr}`;
    assert.match(output, /real-block-run-ai-checklist/);
    assert.match(output, /--strict/);
  });

  test('missing block path exits non-zero', () => {
    const result = runCli(['real-block-run-ai-checklist']);
    assert.notStrictEqual(result.status, 0);
    const output = `${result.stdout}\n${result.stderr}`;
    assert.match(output, /block definition path is required/i);
  });

  test('valid fresh block with env returns JSON parseable output', () => {
    const repoPath = createTempRepo();
    const blockPath = createBlockFile(repoPath);
    const result = runCli(['real-block-run-ai-checklist', blockPath], buildEnv());
    if (result.status !== 0) {
      console.error(result.stdout + result.stderr);
    }
    assert.strictEqual(result.status, 0, result.stdout + result.stderr);
    const parsed = parseOutput(result.stdout) as Record<string, unknown>;
    assert.strictEqual(parsed.mode, 'real-block-run-ai-checklist');
  });

  test('valid fresh block output includes blockReadiness.ready true', () => {
    const repoPath = createTempRepo();
    const blockPath = createBlockFile(repoPath);
    const result = runCli(['real-block-run-ai-checklist', blockPath], buildEnv());
    assert.strictEqual(result.status, 0, result.stdout + result.stderr);
    const parsed = parseOutput(result.stdout) as Record<string, unknown>;
    const readiness = parsed.blockReadiness as Record<string, unknown>;
    assert.strictEqual(readiness.ready, true);
  });

  test('valid fresh block output includes providerSmoke.envReady true', () => {
    const repoPath = createTempRepo();
    const blockPath = createBlockFile(repoPath);
    const result = runCli(['real-block-run-ai-checklist', blockPath], buildEnv());
    assert.strictEqual(result.status, 0, result.stdout + result.stderr);
    const parsed = parseOutput(result.stdout) as Record<string, unknown>;
    const smoke = parsed.providerSmoke as Record<string, unknown>;
    assert.strictEqual(smoke.envReady, true);
  });

  test('valid fresh block output includes provider smoke command', () => {
    const repoPath = createTempRepo();
    const blockPath = createBlockFile(repoPath);
    const result = runCli(['real-block-run-ai-checklist', blockPath], buildEnv());
    assert.strictEqual(result.status, 0, result.stdout + result.stderr);
    const parsed = parseOutput(result.stdout) as Record<string, unknown>;
    const commands = parsed.nextCommands as string[];
    assert.ok(commands.some((c) => c.includes('real-provider-smoke')));
  });

  test('valid fresh block output includes real block run command', () => {
    const repoPath = createTempRepo();
    const blockPath = createBlockFile(repoPath);
    const result = runCli(['real-block-run-ai-checklist', blockPath], buildEnv());
    assert.strictEqual(result.status, 0, result.stdout + result.stderr);
    const parsed = parseOutput(result.stdout) as Record<string, unknown>;
    const commands = parsed.nextCommands as string[];
    assert.ok(commands.some((c) => c.includes('real-block-run-ai')));
  });

  test('missing block opt-in makes ok false', () => {
    const repoPath = createTempRepo();
    const blockPath = createBlockFile(repoPath);
    const result = runCli(
      ['real-block-run-ai-checklist', blockPath],
      buildEnv({ ALLOW_REAL_BLOCK_RUN_AI: '' })
    );
    assert.notStrictEqual(result.status, 0);
    const parsed = parseOutput(result.stdout + result.stderr) as Record<string, unknown>;
    assert.strictEqual(parsed.ok, false);
  });

  test('missing provider env makes ok false', () => {
    const repoPath = createTempRepo();
    const blockPath = createBlockFile(repoPath);
    const result = runCli(
      ['real-block-run-ai-checklist', blockPath],
      buildEnv({ KIMI_API_KEY: '' })
    );
    assert.notStrictEqual(result.status, 0);
    const parsed = parseOutput(result.stdout + result.stderr) as Record<string, unknown>;
    assert.strictEqual(parsed.ok, false);
  });

  test('missing KIMI_API_KEY is listed in provider missingEnv', () => {
    const repoPath = createTempRepo();
    const blockPath = createBlockFile(repoPath);
    const result = runCli(
      ['real-block-run-ai-checklist', blockPath],
      buildEnv({ KIMI_API_KEY: '' })
    );
    const parsed = parseOutput(result.stdout + result.stderr) as Record<string, unknown>;
    const smoke = parsed.providerSmoke as Record<string, unknown>;
    const missing = smoke.missingEnv as string[];
    assert.ok(missing.includes('KIMI_API_KEY'));
  });

  test('missing KIMI_BASE_URL is listed in provider missingEnv', () => {
    const repoPath = createTempRepo();
    const blockPath = createBlockFile(repoPath);
    const result = runCli(
      ['real-block-run-ai-checklist', blockPath],
      buildEnv({ KIMI_BASE_URL: '' })
    );
    const parsed = parseOutput(result.stdout + result.stderr) as Record<string, unknown>;
    const smoke = parsed.providerSmoke as Record<string, unknown>;
    const missing = smoke.missingEnv as string[];
    assert.ok(missing.includes('KIMI_BASE_URL'));
  });

  test('missing provider env does not call provider', () => {
    const result = checkProviderSmokeReadiness({}, 'kimi');
    assert.strictEqual(result.envReady, false);
    assert.deepStrictEqual(result.missingEnv, ['ALLOW_REAL_PROVIDER', 'KIMI_API_KEY', 'KIMI_BASE_URL']);
  });

  test('ALLOW_REAL_PROVIDER=1 makes provider smoke env ready', () => {
    const result = checkProviderSmokeReadiness({
      ALLOW_REAL_PROVIDER: '1',
      KIMI_API_KEY: 'sk-test',
      KIMI_BASE_URL: 'http://localhost.invalid',
    }, 'kimi');
    assert.strictEqual(result.envReady, true);
    assert.strictEqual(result.missingEnv, undefined);
  });

  test('ALLOW_REAL_PROVIDER=false makes provider smoke env not ready', () => {
    const result = checkProviderSmokeReadiness({
      ALLOW_REAL_PROVIDER: 'false',
      KIMI_API_KEY: 'sk-test',
      KIMI_BASE_URL: 'http://localhost.invalid',
    }, 'kimi');
    assert.strictEqual(result.envReady, false);
    assert.deepStrictEqual(result.missingEnv, ['ALLOW_REAL_PROVIDER']);
  });

  test('ALLOW_REAL_PROVIDER=yes makes provider smoke env not ready', () => {
    const result = checkProviderSmokeReadiness({
      ALLOW_REAL_PROVIDER: 'yes',
      KIMI_API_KEY: 'sk-test',
      KIMI_BASE_URL: 'http://localhost.invalid',
    }, 'kimi');
    assert.strictEqual(result.envReady, false);
    assert.deepStrictEqual(result.missingEnv, ['ALLOW_REAL_PROVIDER']);
  });

  test('ALLOW_REAL_PROVIDER=0 makes provider smoke env not ready', () => {
    const result = checkProviderSmokeReadiness({
      ALLOW_REAL_PROVIDER: '0',
      KIMI_API_KEY: 'sk-test',
      KIMI_BASE_URL: 'http://localhost.invalid',
    }, 'kimi');
    assert.strictEqual(result.envReady, false);
    assert.deepStrictEqual(result.missingEnv, ['ALLOW_REAL_PROVIDER']);
  });

  test('checklist never calls runRealProviderSmoke', () => {
    const source = readFileSync(SOURCE_PATH, 'utf-8');
    assert.doesNotMatch(source, /runRealProviderSmoke/);
  });

  test('checklist source does not call fetch/http directly', () => {
    const source = readFileSync(SOURCE_PATH, 'utf-8');
    assert.doesNotMatch(source, /\bfetch\s*\(/);
    assert.doesNotMatch(source, /http\.request/);
    assert.doesNotMatch(source, /https\.request/);
  });

  test('checklist source never writes state', () => {
    const source = readFileSync(SOURCE_PATH, 'utf-8');
    assert.doesNotMatch(source, /writeFileSync/);
    assert.doesNotMatch(source, /saveBlockState/);
  });

  test('checklist source never spawns block runner', () => {
    const source = readFileSync(SOURCE_PATH, 'utf-8');
    assert.doesNotMatch(source, /real-block-run-ai'/);
    assert.doesNotMatch(source, /runRealBlockRunAI/);
  });

  test('checklist source never runs git commit/push/merge', () => {
    const source = readFileSync(SOURCE_PATH, 'utf-8');
    assert.doesNotMatch(source, /['"]commit['"]/);
    assert.doesNotMatch(source, /['"]push['"]/);
    assert.doesNotMatch(source, /['"]merge['"]/);
  });

  test('checklist output redacts secret-like env values', () => {
    const repoPath = createTempRepo();
    const blockPath = createBlockFile(repoPath);
    const result = runCli(
      ['real-block-run-ai-checklist', blockPath],
      buildEnv({ KIMI_API_KEY: 'sk-real-secret-key-1234567890' })
    );
    const output = `${result.stdout}\n${result.stderr}`;
    assert.doesNotMatch(output, /sk-real-secret-key-1234567890/);
  });

  test('resume flag is reflected in output', () => {
    const repoPath = createTempRepo();
    const blockPath = createBlockFile(repoPath);
    const result = runCli(['real-block-run-ai-checklist', blockPath, '--resume'], buildEnv());
    const parsed = parseOutput(result.stdout + result.stderr) as Record<string, unknown>;
    assert.strictEqual(parsed.resume, true);
  });

  test('unsupported provider makes ok false', () => {
    const repoPath = createTempRepo();
    const blockPath = createBlockFile(repoPath);
    const result = runCli(
      ['real-block-run-ai-checklist', blockPath, '--provider', 'openai'],
      buildEnv()
    );
    assert.notStrictEqual(result.status, 0);
    const parsed = parseOutput(result.stdout + result.stderr) as Record<string, unknown>;
    assert.strictEqual(parsed.ok, false);
  });

  test('unsupported provider exits before provider env checks', () => {
    const result = checkProviderSmokeReadiness({}, 'openai');
    assert.strictEqual(result.supported, false);
    assert.strictEqual(result.envReady, false);
    assert.strictEqual(result.missingEnv, undefined);
  });

  test('unsafe provider string is not echoed raw', () => {
    const result = checkProviderSmokeReadiness({}, 'openai;rm -rf');
    assert.strictEqual(result.supported, false);
    assert.strictEqual(result.provider, 'unknown');
  });

  test('output is JSON parseable for failures', () => {
    const repoPath = createTempRepo();
    const blockPath = createBlockFile(repoPath);
    const result = runCli(
      ['real-block-run-ai-checklist', blockPath],
      buildEnv({ ALLOW_REAL_BLOCK_RUN_AI: '' })
    );
    assert.notStrictEqual(result.status, 0);
    const parsed = parseOutput(result.stdout + result.stderr) as Record<string, unknown>;
    assert.strictEqual(parsed.mode, 'real-block-run-ai-checklist');
    assert.strictEqual(parsed.ok, false);
  });

  test('non-strict checklist does not fail on warning-only block', () => {
    const repoPath = createTempRepo();
    const blockPath = createBlockFile(repoPath);
    const result = runCli(['real-block-run-ai-checklist', blockPath], buildEnv());
    assert.strictEqual(result.status, 0, result.stdout + result.stderr);
    const parsed = parseOutput(result.stdout) as Record<string, unknown>;
    assert.strictEqual(parsed.ok, true);
    const blockValidation = parsed.blockValidation as Record<string, unknown>;
    assert.strictEqual(blockValidation.ok, true);
    assert.ok(Array.isArray(blockValidation.warnings));
  });

  test('strict checklist valid block exits 0', () => {
    const repoPath = createTempRepo();
    const tmpDir = mkdtempSync(join(tmpdir(), 'checklist-strict-valid-'));
    const blockPath = join(tmpDir, 'block.json');
    const block = {
      block_id: 'block_strict_valid',
      title: 'Strict valid block',
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
          goal: 'Update README safely.',
          allowed_files: ['README.md'],
          denied_files: [],
          max_lines_changed: 100,
          checks: ['npm run typecheck'],
        },
      ],
    };
    writeFileSync(blockPath, JSON.stringify(block, null, 2), 'utf-8');
    const result = runCli(['real-block-run-ai-checklist', blockPath, '--strict'], buildEnv());
    assert.strictEqual(result.status, 0, result.stdout + result.stderr);
    const parsed = parseOutput(result.stdout) as Record<string, unknown>;
    assert.strictEqual(parsed.ok, true);
    assert.strictEqual(parsed.strict, true);
    const blockValidation = parsed.blockValidation as Record<string, unknown>;
    assert.strictEqual(blockValidation.ok, true);
    assert.strictEqual(blockValidation.strict, true);
    assert.deepStrictEqual(blockValidation.warnings, []);
  });

  test('strict checklist warning-only block exits non-zero', () => {
    const repoPath = createTempRepo();
    const blockPath = createBlockFile(repoPath);
    const result = runCli(['real-block-run-ai-checklist', blockPath, '--strict'], buildEnv());
    assert.notStrictEqual(result.status, 0);
    const parsed = parseOutput(result.stdout + result.stderr) as Record<string, unknown>;
    assert.strictEqual(parsed.ok, false);
    assert.strictEqual(parsed.strict, true);
  });

  test('strict checklist warning-only output has blockValidation ok false', () => {
    const repoPath = createTempRepo();
    const blockPath = createBlockFile(repoPath);
    const result = runCli(['real-block-run-ai-checklist', blockPath, '--strict'], buildEnv());
    const parsed = parseOutput(result.stdout + result.stderr) as Record<string, unknown>;
    const blockValidation = parsed.blockValidation as Record<string, unknown>;
    assert.strictEqual(blockValidation.ok, false);
    assert.strictEqual(blockValidation.strict, true);
    assert.strictEqual(blockValidation.warningsAsErrors, true);
  });

  test('strict checklist warning-only output includes validation warnings', () => {
    const repoPath = createTempRepo();
    const blockPath = createBlockFile(repoPath);
    const result = runCli(['real-block-run-ai-checklist', blockPath, '--strict'], buildEnv());
    const parsed = parseOutput(result.stdout + result.stderr) as Record<string, unknown>;
    const blockValidation = parsed.blockValidation as Record<string, unknown>;
    const warnings = blockValidation.warnings as string[];
    assert.ok(warnings.some((w) => /empty checks/i.test(w)));
  });

  test('strict checklist warning-only output includes strict failure reason', () => {
    const repoPath = createTempRepo();
    const blockPath = createBlockFile(repoPath);
    const result = runCli(['real-block-run-ai-checklist', blockPath, '--strict'], buildEnv());
    const parsed = parseOutput(result.stdout + result.stderr) as Record<string, unknown>;
    const reasons = parsed.reasons as string[];
    assert.ok(reasons.some((r) => /Strict block validation failed/i.test(r)));
  });

  test('strict checklist warning-only output does not suggest real block run', () => {
    const repoPath = createTempRepo();
    const blockPath = createBlockFile(repoPath);
    const result = runCli(['real-block-run-ai-checklist', blockPath, '--strict'], buildEnv());
    const parsed = parseOutput(result.stdout + result.stderr) as Record<string, unknown>;
    const commands = parsed.nextCommands as string[];
    assert.ok(!commands.some((c) => c.includes('real-block-run-ai ')));
  });

  test('strict checklist structural invalid block exits non-zero', () => {
    const repoPath = createTempRepo();
    const blockPath = createBlockFile(repoPath);
    const block = JSON.parse(readFileSync(blockPath, 'utf-8'));
    delete block.block_id;
    writeFileSync(blockPath, JSON.stringify(block), 'utf-8');
    const result = runCli(['real-block-run-ai-checklist', blockPath, '--strict'], buildEnv());
    assert.notStrictEqual(result.status, 0);
    const parsed = parseOutput(result.stdout + result.stderr) as Record<string, unknown>;
    assert.strictEqual(parsed.ok, false);
    const blockValidation = parsed.blockValidation as Record<string, unknown>;
    assert.strictEqual(blockValidation.ok, false);
  });

  test('strict checklist missing provider env still reports provider env issues', () => {
    const repoPath = createTempRepo();
    const blockPath = createBlockFile(repoPath);
    const result = runCli(
      ['real-block-run-ai-checklist', blockPath, '--strict'],
      buildEnv({ KIMI_API_KEY: '' })
    );
    assert.notStrictEqual(result.status, 0);
    const parsed = parseOutput(result.stdout + result.stderr) as Record<string, unknown>;
    const smoke = parsed.providerSmoke as Record<string, unknown>;
    assert.strictEqual(smoke.envReady, false);
    const missing = smoke.missingEnv as string[];
    assert.ok(missing.includes('KIMI_API_KEY'));
  });

  test('strict checklist with unsupported provider does not require provider env', () => {
    const repoPath = createTempRepo();
    const blockPath = createBlockFile(repoPath);
    const result = runCli(
      ['real-block-run-ai-checklist', blockPath, '--strict', '--provider', 'openai'],
      buildEnv({ KIMI_API_KEY: '', KIMI_BASE_URL: '', ALLOW_REAL_PROVIDER: '' })
    );
    assert.notStrictEqual(result.status, 0);
    const parsed = parseOutput(result.stdout + result.stderr) as Record<string, unknown>;
    const smoke = parsed.providerSmoke as Record<string, unknown>;
    assert.strictEqual(smoke.supported, false);
    assert.strictEqual(smoke.missingEnv, undefined);
  });

  test('strict checklist output redacts secret-like values', () => {
    const repoPath = createTempRepo();
    const blockPath = createBlockFile(repoPath);
    const result = runCli(
      ['real-block-run-ai-checklist', blockPath, '--strict'],
      buildEnv({ KIMI_API_KEY: 'sk-real-secret-key-1234567890' })
    );
    const output = `${result.stdout}\n${result.stderr}`;
    assert.doesNotMatch(output, /sk-real-secret-key-1234567890/);
  });
});

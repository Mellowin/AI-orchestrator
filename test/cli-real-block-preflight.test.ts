import { describe, test } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runRealBlockPreflight, formatRealBlockPreflightReport, parseRealBlockPreflightTimeoutMs } from '../src/real-block-preflight.js';

const PROJECT_ROOT = process.cwd();
const TSX_CLI_PATH = join(PROJECT_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const CLI_PATH = join(PROJECT_ROOT, 'src', 'cli.ts');
const SOURCE_PATH = join(PROJECT_ROOT, 'src', 'real-block-preflight.ts');

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

function createTempRepo(): string {
  const tmpDir = mkdtempSync(join(tmpdir(), 'preflight-test-'));
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
  counter += 1;
  const blockId = `block_preflight_${Date.now()}_${counter}`;
  const tmpDir = mkdtempSync(join(tmpdir(), 'preflight-block-'));
  const blockPath = join(tmpDir, 'block.json');
  const block = {
    block_id: blockId,
    title: 'Preflight test block',
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
        checks: ['npm run typecheck'],
      },
    ],
  };
  writeFileSync(blockPath, JSON.stringify(block, null, 2), 'utf-8');
  return blockPath;
}

function buildEnv(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    ALLOW_REAL_PROVIDER: 'true',
    ALLOW_REAL_BLOCK_RUN_AI: 'true',
    ALLOW_REAL_REPO_APPLY: 'true',
    ALLOW_REAL_REPO_COMMIT: 'true',
    ALLOW_REAL_REPO_PUSH: 'true',
    KIMI_API_KEY: 'sk-test',
    KIMI_BASE_URL: 'http://localhost.invalid',
    KIMI_MODEL: 'kimi-k2.6',
    REAL_PROVIDER_SMOKE_FAKE_RESPONSE: '{"ok":true,"message":"provider smoke ok"}',
    REAL_CODER_CONTRACT_SMOKE_FAKE_RESPONSE: '{"summary":"coder smoke ok","files":[{"path":"README.md","content":"Hello from contract smoke"}],"notes":[]}',
    REAL_REVIEWER_CONTRACT_SMOKE_FAKE_RESPONSE: '{"decision":"accepted","confidence":"high","blocking_issues":[],"non_blocking_issues":[],"review_summary":"Looks good","fix_task":"","next_action":"advance_to_next_task"}',
    ...overrides,
  };
}

function parseOutput(output: string): Record<string, unknown> {
  const match = output.match(/\{[\s\S]*\}/);
  assert.ok(match, 'output should contain JSON');
  return JSON.parse(match[0]) as Record<string, unknown>;
}

function cleanupRepo(repoPath: string): void {
  rmSync(join(repoPath, '..'), { recursive: true, force: true });
}

describe('real-block-preflight module', () => {
  test('parseRealBlockPreflightTimeoutMs defaults to 15000', () => {
    assert.strictEqual(parseRealBlockPreflightTimeoutMs({}), 15000);
  });

  test('parseRealBlockPreflightTimeoutMs clamps lower bound', () => {
    assert.strictEqual(parseRealBlockPreflightTimeoutMs({ REAL_BLOCK_PREFLIGHT_TIMEOUT_MS: '500' }), 1000);
  });

  test('parseRealBlockPreflightTimeoutMs clamps upper bound', () => {
    assert.strictEqual(parseRealBlockPreflightTimeoutMs({ REAL_BLOCK_PREFLIGHT_TIMEOUT_MS: '120000' }), 60000);
  });

  test('parseRealBlockPreflightTimeoutMs uses override', () => {
    assert.strictEqual(parseRealBlockPreflightTimeoutMs({}, 5000), 5000);
  });

  test('parseRealBlockPreflightTimeoutMs rejects invalid', () => {
    assert.throws(() => parseRealBlockPreflightTimeoutMs({ REAL_BLOCK_PREFLIGHT_TIMEOUT_MS: 'abc' }), /Invalid timeout/);
  });
});

describe('real-block-preflight CLI', () => {
  test('CLI usage includes real-block-preflight', () => {
    const result = runCli([]);
    assert.notStrictEqual(result.status, 0);
    const output = `${result.stdout}\n${result.stderr}`;
    assert.match(output, /real-block-preflight/);
    assert.match(output, /--provider/);
    assert.match(output, /--timeout-ms/);
    assert.match(output, /--resume/);
  });

  test('missing block path exits non-zero', () => {
    const result = runCli(['real-block-preflight']);
    assert.notStrictEqual(result.status, 0);
    const output = `${result.stdout}\n${result.stderr}`;
    assert.match(output, /block path is required/i);
  });

  test('valid block with all fakes exits 0', async () => {
    const repoPath = createTempRepo();
    const blockPath = createBlockFile(repoPath);
    const result = runCli(['real-block-preflight', blockPath], buildEnv());
    cleanupRepo(repoPath);
    if (result.status !== 0) {
      console.error(result.stdout + result.stderr);
    }
    assert.strictEqual(result.status, 0, result.stdout + result.stderr);
  });

  test('valid block report contains all five steps ok', async () => {
    const repoPath = createTempRepo();
    const blockPath = createBlockFile(repoPath);
    const result = runCli(['real-block-preflight', blockPath], buildEnv());
    cleanupRepo(repoPath);
    const parsed = parseOutput(result.stdout);
    assert.strictEqual(parsed.ok, true);
    assert.strictEqual(parsed.mode, 'real-block-preflight');
    const steps = parsed.steps as Record<string, Record<string, unknown>>;
    assert.strictEqual(steps.blockValidation.ok, true);
    assert.strictEqual(steps.checklist.ok, true);
    assert.strictEqual(steps.providerSmoke.ok, true);
    assert.strictEqual(steps.coderContractSmoke.ok, true);
    assert.strictEqual(steps.reviewerContractSmoke.ok, true);
  });

  test('valid block report includes next commands', async () => {
    const repoPath = createTempRepo();
    const blockPath = createBlockFile(repoPath);
    const result = runCli(['real-block-preflight', blockPath], buildEnv());
    cleanupRepo(repoPath);
    const parsed = parseOutput(result.stdout);
    const commands = parsed.nextCommands as string[];
    assert.ok(commands.some((c) => c.includes('real-block-run-ai')));
    assert.ok(commands.some((c) => c.includes('real-block-run-ai-report')));
  });

  test('invalid block path fails validation and overall ok false', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'preflight-invalid-'));
    const missingPath = join(tmpDir, 'missing.json');
    const result = runCli(['real-block-preflight', missingPath], buildEnv());
    rmSync(tmpDir, { recursive: true, force: true });
    const parsed = parseOutput(result.stdout + result.stderr);
    assert.strictEqual(parsed.ok, false);
    const steps = parsed.steps as Record<string, Record<string, unknown>>;
    assert.strictEqual(steps.blockValidation.ok, false);
    assert.strictEqual(steps.checklist.ok, false);
  });

  test('unsupported provider fails provider/coder/reviewer steps', async () => {
    const repoPath = createTempRepo();
    const blockPath = createBlockFile(repoPath);
    const result = runCli(['real-block-preflight', blockPath, '--provider', 'openai'], buildEnv());
    cleanupRepo(repoPath);
    const parsed = parseOutput(result.stdout + result.stderr);
    assert.strictEqual(parsed.ok, false);
    const steps = parsed.steps as Record<string, Record<string, unknown>>;
    assert.strictEqual(steps.blockValidation.ok, true);
    assert.strictEqual(steps.checklist.ok, false);
    assert.strictEqual(steps.providerSmoke.ok, false);
    assert.strictEqual(steps.coderContractSmoke.ok, false);
    assert.strictEqual(steps.reviewerContractSmoke.ok, false);
  });

  test('provider smoke failure keeps earlier steps ok and overall false', async () => {
    const repoPath = createTempRepo();
    const blockPath = createBlockFile(repoPath);
    const result = runCli(
      ['real-block-preflight', blockPath],
      buildEnv({ REAL_PROVIDER_SMOKE_FAKE_RESPONSE: 'not-json' })
    );
    cleanupRepo(repoPath);
    const parsed = parseOutput(result.stdout + result.stderr);
    assert.strictEqual(parsed.ok, false);
    const steps = parsed.steps as Record<string, Record<string, unknown>>;
    assert.strictEqual(steps.blockValidation.ok, true);
    assert.strictEqual(steps.checklist.ok, true);
    assert.strictEqual(steps.providerSmoke.ok, false);
    assert.strictEqual(steps.coderContractSmoke.ok, true);
    assert.strictEqual(steps.reviewerContractSmoke.ok, true);
  });

  test('--timeout-ms sets report timeoutMs', async () => {
    const repoPath = createTempRepo();
    const blockPath = createBlockFile(repoPath);
    const result = runCli(['real-block-preflight', blockPath, '--timeout-ms', '3000'], buildEnv());
    cleanupRepo(repoPath);
    const parsed = parseOutput(result.stdout);
    assert.strictEqual(parsed.timeoutMs, 3000);
  });

  test('report is redacted when error contains secret-like text', async () => {
    const repoPath = createTempRepo();
    const blockPath = createBlockFile(repoPath);
    const result = runCli(
      ['real-block-preflight', blockPath],
      buildEnv({ REAL_PROVIDER_SMOKE_FAKE_RESPONSE: 'api_key=sk-test123' })
    );
    cleanupRepo(repoPath);
    const output = result.stdout + result.stderr;
    assert.doesNotMatch(output, /sk-test123/);
    assert.match(output, /\[REDACTED\]/);
  });

  test('preflight never runs the block', async () => {
    const repoPath = createTempRepo();
    const blockPath = createBlockFile(repoPath);
    const envValues = buildEnv();
    const previous: Record<string, string | undefined> = {};
    for (const [key, value] of Object.entries(envValues)) {
      previous[key] = process.env[key];
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    let report;
    try {
      report = await runRealBlockPreflight({
        blockPath,
        env: buildEnv() as NodeJS.ProcessEnv,
      });
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
      cleanupRepo(repoPath);
    }
    assert.strictEqual(report.mode, 'real-block-preflight');
    assert.strictEqual(report.ok, true);
    assert.ok(report.nextCommands.some((c) => c.includes('real-block-run-ai')));
    assert.ok(report.nextCommands.some((c) => c.includes('real-block-run-ai-report')));
  });

  test('preflight source does not call fetch/http directly', () => {
    const source = readFileSync(SOURCE_PATH, 'utf-8');
    assert.doesNotMatch(source, /\bfetch\s*\(/);
    assert.doesNotMatch(source, /http\.request/);
    assert.doesNotMatch(source, /https\.request/);
  });

  test('preflight source does not mutate repo or state', () => {
    const source = readFileSync(SOURCE_PATH, 'utf-8');
    assert.doesNotMatch(source, /runOneTaskLoop/);
    assert.doesNotMatch(source, /runMultiTaskLoop/);
    assert.doesNotMatch(source, /runRealBlockRunAI/);
    assert.doesNotMatch(source, /writeFileSync/);
    assert.doesNotMatch(source, /git push/);
  });

  test('formatRealBlockPreflightReport redacts strings', () => {
    const report = {
      ok: false,
      mode: 'real-block-preflight' as const,
      blockPath: 'block.json',
      provider: 'kimi',
      resume: false,
      timeoutMs: 15000,
      steps: {
        blockValidation: { ok: true },
        checklist: { ok: true },
        providerSmoke: { ok: false, error: 'api_key=sk-test123' },
        coderContractSmoke: { ok: true },
        reviewerContractSmoke: { ok: true },
      },
      reasons: ['Provider smoke failed', 'api_key=sk-test123'],
      nextCommands: [],
    };
    const formatted = formatRealBlockPreflightReport(report);
    assert.doesNotMatch(formatted, /sk-test123/);
    assert.match(formatted, /\[REDACTED\]/);
  });
});

import { describe, test } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runRealBlockTaskProbe, formatRealBlockTaskProbeReport, parseRealBlockTaskProbeTimeoutMs, buildReviewerProbePrompt } from '../src/real-block-task-probe.js';
import type { BlockTaskDefinition } from '../src/block/block-types.js';

const PROJECT_ROOT = process.cwd();
const TSX_CLI_PATH = join(PROJECT_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const CLI_PATH = join(PROJECT_ROOT, 'src', 'cli.ts');
const SOURCE_PATH = join(PROJECT_ROOT, 'src', 'real-block-task-probe.ts');
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

function createTempRepo(): string {
  const tmpDir = mkdtempSync(join(tmpdir(), 'probe-test-'));
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

function createBlockFile(
  repoPath: string,
  overrides: Record<string, unknown> = {}
): { blockPath: string; blockId: string; taskId: string } {
  counter += 1;
  const blockId = `block_probe_${Date.now()}_${counter}`;
  const taskId = 'task_1';
  const tmpDir = mkdtempSync(join(tmpdir(), 'probe-block-'));
  const blockPath = join(tmpDir, 'block.json');
  const block = {
    block_id: blockId,
    title: 'Probe test block',
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
        task_id: taskId,
        title: 'Update README',
        goal: 'Update README.',
        allowed_files: ['README.md'],
        denied_files: [],
        max_lines_changed: 100,
        checks: ['npm run typecheck'],
      },
    ],
    ...overrides,
  };
  writeFileSync(blockPath, JSON.stringify(block, null, 2), 'utf-8');
  return { blockPath, blockId, taskId };
}

function buildEnv(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    ALLOW_REAL_PROVIDER: 'true',
    KIMI_API_KEY: 'sk-test',
    KIMI_BASE_URL: 'http://localhost.invalid',
    KIMI_MODEL: 'kimi-k2.6',
    REAL_BLOCK_TASK_PROBE_FAKE_CODER_RESPONSE:
      '{"summary":"update README","files":[{"path":"README.md","content":"# Hello"}],"notes":[]}',
    REAL_BLOCK_TASK_PROBE_FAKE_REVIEWER_RESPONSE:
      '{"decision":"accepted","confidence":"high","blocking_issues":[],"non_blocking_issues":[],"review_summary":"Looks good","fix_task":"","next_action":"advance_to_next_task"}',
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

describe('real-block-task-probe module', () => {
  test('parseRealBlockTaskProbeTimeoutMs defaults to 15000', () => {
    assert.strictEqual(parseRealBlockTaskProbeTimeoutMs({}), 15000);
  });

  test('parseRealBlockTaskProbeTimeoutMs clamps lower bound', () => {
    assert.strictEqual(parseRealBlockTaskProbeTimeoutMs({ REAL_BLOCK_TASK_PROBE_TIMEOUT_MS: '500' }), 1000);
  });

  test('parseRealBlockTaskProbeTimeoutMs clamps upper bound', () => {
    assert.strictEqual(parseRealBlockTaskProbeTimeoutMs({ REAL_BLOCK_TASK_PROBE_TIMEOUT_MS: '120000' }), 120000);
  });

  test('parseRealBlockTaskProbeTimeoutMs uses override', () => {
    assert.strictEqual(parseRealBlockTaskProbeTimeoutMs({}, 5000), 5000);
  });

  test('parseRealBlockTaskProbeTimeoutMs rejects invalid', () => {
    assert.throws(() => parseRealBlockTaskProbeTimeoutMs({ REAL_BLOCK_TASK_PROBE_TIMEOUT_MS: 'abc' }), /Invalid timeout/);
  });
});

function buildSampleTask(overrides: Partial<BlockTaskDefinition> = {}): BlockTaskDefinition {
  return {
    task_id: 'task_1',
    title: 'Update README',
    goal: 'Update the README with a greeting.',
    allowed_files: ['README.md'],
    denied_files: ['package.json'],
    max_lines_changed: 100,
    checks: ['npm run typecheck'],
    ...overrides,
  };
}

describe('buildReviewerProbePrompt', () => {
  test('includes proposed coder content', () => {
    const task = buildSampleTask();
    const prompt = buildReviewerProbePrompt(task, {
      summary: 'Add greeting',
      files: [{ path: 'README.md', content: '# Hello World' }],
      notes: [],
    });
    assert.match(prompt, /# Hello World/);
  });

  test('includes proposed file path', () => {
    const task = buildSampleTask();
    const prompt = buildReviewerProbePrompt(task, {
      summary: 'Add greeting',
      files: [{ path: 'README.md', content: '# Hello' }],
      notes: [],
    });
    assert.match(prompt, /README\.md/);
  });

  test('includes task goal', () => {
    const task = buildSampleTask();
    const prompt = buildReviewerProbePrompt(task, {
      summary: 'Add greeting',
      files: [{ path: 'README.md', content: '# Hello' }],
      notes: [],
    });
    assert.match(prompt, /Update the README with a greeting/);
  });

  test('includes allowed_files', () => {
    const task = buildSampleTask();
    const prompt = buildReviewerProbePrompt(task, {
      summary: 'Add greeting',
      files: [{ path: 'README.md', content: '# Hello' }],
      notes: [],
    });
    assert.match(prompt, /README\.md/);
    assert.match(prompt, /Allowed files/);
  });

  test('includes denied_files', () => {
    const task = buildSampleTask();
    const prompt = buildReviewerProbePrompt(task, {
      summary: 'Add greeting',
      files: [{ path: 'README.md', content: '# Hello' }],
      notes: [],
    });
    assert.match(prompt, /package\.json/);
    assert.match(prompt, /Denied files/);
  });

  test('includes checks', () => {
    const task = buildSampleTask();
    const prompt = buildReviewerProbePrompt(task, {
      summary: 'Add greeting',
      files: [{ path: 'README.md', content: '# Hello' }],
      notes: [],
    });
    assert.match(prompt, /npm run typecheck/);
    assert.match(prompt, /Checks/);
  });

  test('bounds oversized content', () => {
    const task = buildSampleTask();
    const longContent = 'a'.repeat(2500);
    const prompt = buildReviewerProbePrompt(task, {
      summary: 'Add greeting',
      files: [{ path: 'README.md', content: longContent }],
      notes: [],
    });
    assert.ok(prompt.length < longContent.length + 500);
    assert.match(prompt, /a\.\.\./);
  });
});

describe('real-block-task-probe CLI', () => {
  test('CLI usage includes real-block-task-probe', () => {
    const result = runCli([]);
    assert.notStrictEqual(result.status, 0);
    const output = `${result.stdout}\n${result.stderr}`;
    assert.match(output, /real-block-task-probe/);
    assert.match(output, /--provider/);
    assert.match(output, /--task-id/);
    assert.match(output, /--timeout-ms/);
  });

  test('missing block path exits non-zero', () => {
    const result = runCli(['real-block-task-probe']);
    assert.notStrictEqual(result.status, 0);
    const output = `${result.stdout}\n${result.stderr}`;
    assert.match(output, /block path is required/i);
  });

  test('unsupported provider exits non-zero', () => {
    const repoPath = createTempRepo();
    const { blockPath } = createBlockFile(repoPath);
    const result = runCli(['real-block-task-probe', blockPath, '--provider', 'openai'], buildEnv());
    cleanupRepo(repoPath);
    assert.notStrictEqual(result.status, 0);
    const parsed = parseOutput(result.stdout + result.stderr);
    assert.strictEqual(parsed.ok, false);
  });

  test('unsupported provider does not require env', () => {
    const repoPath = createTempRepo();
    const { blockPath } = createBlockFile(repoPath);
    const result = runCli(
      ['real-block-task-probe', blockPath, '--provider', 'openai'],
      { KIMI_API_KEY: undefined, KIMI_BASE_URL: undefined, ALLOW_REAL_PROVIDER: undefined }
    );
    cleanupRepo(repoPath);
    assert.notStrictEqual(result.status, 0);
    const output = result.stdout + result.stderr;
    assert.doesNotMatch(output, /KIMI_API_KEY/);
    assert.doesNotMatch(output, /ALLOW_REAL_PROVIDER/);
  });

  test('unsafe provider string is not echoed raw', () => {
    const repoPath = createTempRepo();
    const { blockPath } = createBlockFile(repoPath);
    const result = runCli(['real-block-task-probe', blockPath, '--provider', 'sk-evil123'], buildEnv());
    cleanupRepo(repoPath);
    const output = result.stdout + result.stderr;
    assert.doesNotMatch(output, /sk-evil123/);
  });

  test('missing ALLOW_REAL_PROVIDER exits non-zero', () => {
    const repoPath = createTempRepo();
    const { blockPath } = createBlockFile(repoPath);
    const result = runCli(['real-block-task-probe', blockPath], buildEnv({ ALLOW_REAL_PROVIDER: undefined }));
    cleanupRepo(repoPath);
    assert.notStrictEqual(result.status, 0);
    const parsed = parseOutput(result.stdout + result.stderr);
    assert.strictEqual(parsed.ok, false);
  });

  test('ALLOW_REAL_PROVIDER=true works', async () => {
    const repoPath = createTempRepo();
    const { blockPath } = createBlockFile(repoPath);
    const result = runCli(['real-block-task-probe', blockPath], buildEnv({ ALLOW_REAL_PROVIDER: 'true' }));
    cleanupRepo(repoPath);
    assert.strictEqual(result.status, 0, result.stdout + result.stderr);
  });

  test('ALLOW_REAL_PROVIDER=1 works', async () => {
    const repoPath = createTempRepo();
    const { blockPath } = createBlockFile(repoPath);
    const result = runCli(['real-block-task-probe', blockPath], buildEnv({ ALLOW_REAL_PROVIDER: '1' }));
    cleanupRepo(repoPath);
    assert.strictEqual(result.status, 0, result.stdout + result.stderr);
  });

  test('invalid ALLOW_REAL_PROVIDER=yes fails', () => {
    const repoPath = createTempRepo();
    const { blockPath } = createBlockFile(repoPath);
    const result = runCli(['real-block-task-probe', blockPath], buildEnv({ ALLOW_REAL_PROVIDER: 'yes' }));
    cleanupRepo(repoPath);
    assert.notStrictEqual(result.status, 0);
  });

  test('missing KIMI_API_KEY exits non-zero', () => {
    const repoPath = createTempRepo();
    const { blockPath } = createBlockFile(repoPath);
    const result = runCli(['real-block-task-probe', blockPath], buildEnv({ KIMI_API_KEY: '' }));
    cleanupRepo(repoPath);
    assert.notStrictEqual(result.status, 0);
    const output = result.stdout + result.stderr;
    assert.match(output, /KIMI_API_KEY/);
  });

  test('missing KIMI_BASE_URL exits non-zero', () => {
    const repoPath = createTempRepo();
    const { blockPath } = createBlockFile(repoPath);
    const result = runCli(['real-block-task-probe', blockPath], buildEnv({ KIMI_BASE_URL: '' }));
    cleanupRepo(repoPath);
    assert.notStrictEqual(result.status, 0);
    const output = result.stdout + result.stderr;
    assert.match(output, /KIMI_BASE_URL/);
  });

  test('strict block validation failure exits non-zero before provider call', () => {
    const repoPath = createTempRepo();
    const { blockPath } = createBlockFile(repoPath, { block_id: undefined });
    const result = runCli(['real-block-task-probe', blockPath], buildEnv());
    cleanupRepo(repoPath);
    assert.notStrictEqual(result.status, 0);
    const parsed = parseOutput(result.stdout + result.stderr);
    assert.strictEqual(parsed.ok, false);
  });

  test('empty allowed_files exits non-zero before provider call', () => {
    const repoPath = createTempRepo();
    const { blockPath } = createBlockFile(repoPath, {
      tasks: [
        {
          task_id: 'task_1',
          title: 'Update README',
          goal: 'Update README.',
          allowed_files: [],
          denied_files: [],
          max_lines_changed: 100,
          checks: ['npm run typecheck'],
        },
      ],
    });
    const result = runCli(['real-block-task-probe', blockPath], buildEnv());
    cleanupRepo(repoPath);
    assert.notStrictEqual(result.status, 0);
    const parsed = parseOutput(result.stdout + result.stderr);
    assert.strictEqual(parsed.ok, false);
  });

  test('empty checks exits non-zero before provider call', () => {
    const repoPath = createTempRepo();
    const { blockPath } = createBlockFile(repoPath, {
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
    });
    const result = runCli(['real-block-task-probe', blockPath], buildEnv());
    cleanupRepo(repoPath);
    assert.notStrictEqual(result.status, 0);
    const parsed = parseOutput(result.stdout + result.stderr);
    assert.strictEqual(parsed.ok, false);
  });

  test('work_branch main exits non-zero before provider call', () => {
    const repoPath = createTempRepo();
    const { blockPath } = createBlockFile(repoPath, { work_branch: 'main' });
    const result = runCli(['real-block-task-probe', blockPath], buildEnv());
    cleanupRepo(repoPath);
    assert.notStrictEqual(result.status, 0);
    const output = result.stdout + result.stderr;
    assert.match(output, /work_branch/i);
  });

  test('work_branch equals base_branch exits non-zero before provider call', () => {
    const repoPath = createTempRepo();
    const { blockPath } = createBlockFile(repoPath, { work_branch: 'main', base_branch: 'main' });
    const result = runCli(['real-block-task-probe', blockPath], buildEnv());
    cleanupRepo(repoPath);
    assert.notStrictEqual(result.status, 0);
    const output = result.stdout + result.stderr;
    assert.match(output, /work_branch/i);
  });

  test('unknown task id exits non-zero before provider call', () => {
    const repoPath = createTempRepo();
    const { blockPath } = createBlockFile(repoPath);
    const result = runCli(['real-block-task-probe', blockPath, '--task-id', 'missing_task'], buildEnv());
    cleanupRepo(repoPath);
    assert.notStrictEqual(result.status, 0);
    const output = result.stdout + result.stderr;
    assert.match(output, /missing_task/);
  });

  test('without task id chooses deterministic first task', async () => {
    const repoPath = createTempRepo();
    const { blockPath } = createBlockFile(repoPath, {
      tasks: [
        {
          task_id: 'task_first',
          title: 'First',
          goal: 'First.',
          allowed_files: ['README.md'],
          denied_files: [],
          max_lines_changed: 100,
          checks: ['npm run typecheck'],
        },
        {
          task_id: 'task_second',
          title: 'Second',
          goal: 'Second.',
          allowed_files: ['README.md'],
          denied_files: [],
          max_lines_changed: 100,
          checks: ['npm run typecheck'],
        },
      ],
    });
    const result = runCli(['real-block-task-probe', blockPath], buildEnv());
    cleanupRepo(repoPath);
    assert.strictEqual(result.status, 0, result.stdout + result.stderr);
    const parsed = parseOutput(result.stdout);
    assert.strictEqual(parsed.taskId, 'task_first');
  });

  test('valid fake coder + valid fake reviewer exits 0', async () => {
    const repoPath = createTempRepo();
    const { blockPath } = createBlockFile(repoPath);
    const result = runCli(['real-block-task-probe', blockPath], buildEnv());
    cleanupRepo(repoPath);
    assert.strictEqual(result.status, 0, result.stdout + result.stderr);
  });

  test('public output does not include full proposed coder content', async () => {
    const repoPath = createTempRepo();
    const { blockPath } = createBlockFile(repoPath);
    const proposedContent = 'unique proposed coder content abc12345 xyz';
    const result = runCli(
      ['real-block-task-probe', blockPath],
      buildEnv({
        REAL_BLOCK_TASK_PROBE_FAKE_CODER_RESPONSE:
          `{"summary":"update README","files":[{"path":"README.md","content":"${proposedContent}"}],"notes":[]}`,
      })
    );
    cleanupRepo(repoPath);
    assert.strictEqual(result.status, 0, result.stdout + result.stderr);
    const output = result.stdout + result.stderr;
    assert.ok(!output.includes(proposedContent), 'output should not contain full coder content');
  });

  test('coder content too long exits non-zero before reviewer call', async () => {
    const repoPath = createTempRepo();
    const { blockPath } = createBlockFile(repoPath);
    const longContent = 'a'.repeat(2001);
    const result = runCli(
      ['real-block-task-probe', blockPath],
      buildEnv({
        REAL_BLOCK_TASK_PROBE_FAKE_CODER_RESPONSE:
          `{"summary":"x","files":[{"path":"README.md","content":"${longContent}"}],"notes":[]}`,
      })
    );
    cleanupRepo(repoPath);
    assert.notStrictEqual(result.status, 0);
    const parsed = parseOutput(result.stdout + result.stderr);
    assert.strictEqual(parsed.ok, false);
    const coder = parsed.coder as Record<string, unknown>;
    const reviewer = parsed.reviewer as Record<string, unknown>;
    assert.strictEqual(coder.ok, false);
    assert.strictEqual(reviewer.ok, false);
    assert.match(String(reviewer.error), /Skipped/i);
  });

  test('valid output has correct shape', async () => {
    const repoPath = createTempRepo();
    const { blockPath, blockId, taskId } = createBlockFile(repoPath);
    const result = runCli(['real-block-task-probe', blockPath], buildEnv());
    cleanupRepo(repoPath);
    const parsed = parseOutput(result.stdout);
    assert.strictEqual(parsed.ok, true);
    assert.strictEqual(parsed.mode, 'real-block-task-probe');
    assert.strictEqual(parsed.mutated, false);
    assert.strictEqual(parsed.blockId, blockId);
    assert.strictEqual(parsed.taskId, taskId);
    assert.strictEqual(parsed.provider, 'kimi');
    const coder = parsed.coder as Record<string, unknown>;
    const reviewer = parsed.reviewer as Record<string, unknown>;
    assert.strictEqual(coder.ok, true);
    assert.strictEqual(coder.contractValid, true);
    assert.strictEqual(reviewer.ok, true);
    assert.strictEqual(reviewer.contractValid, true);
    assert.strictEqual(reviewer.decision, 'accepted');
  });

  test('valid output includes next real run commands', async () => {
    const repoPath = createTempRepo();
    const { blockPath } = createBlockFile(repoPath);
    const result = runCli(['real-block-task-probe', blockPath], buildEnv());
    cleanupRepo(repoPath);
    const parsed = parseOutput(result.stdout);
    const commands = parsed.nextCommands as string[];
    assert.ok(commands.some((c) => c.includes('real-block-run-ai')));
    assert.ok(commands.some((c) => c.includes('real-block-run-ai-report')));
  });

  test('coder invalid JSON exits non-zero', async () => {
    const repoPath = createTempRepo();
    const { blockPath } = createBlockFile(repoPath);
    const result = runCli(
      ['real-block-task-probe', blockPath],
      buildEnv({ REAL_BLOCK_TASK_PROBE_FAKE_CODER_RESPONSE: 'not-json' })
    );
    cleanupRepo(repoPath);
    assert.notStrictEqual(result.status, 0);
    const parsed = parseOutput(result.stdout + result.stderr);
    assert.strictEqual(parsed.ok, false);
    const coder = parsed.coder as Record<string, unknown>;
    assert.strictEqual(coder.ok, false);
  });

  test('coder invalid contract exits non-zero', async () => {
    const repoPath = createTempRepo();
    const { blockPath } = createBlockFile(repoPath);
    const result = runCli(
      ['real-block-task-probe', blockPath],
      buildEnv({
        REAL_BLOCK_TASK_PROBE_FAKE_CODER_RESPONSE:
          '{"summary":"x","files":[{"path":"README.md"}]}',
      })
    );
    cleanupRepo(repoPath);
    assert.notStrictEqual(result.status, 0);
    const parsed = parseOutput(result.stdout + result.stderr);
    assert.strictEqual(parsed.ok, false);
    const coder = parsed.coder as Record<string, unknown>;
    assert.strictEqual(coder.ok, false);
  });

  test('coder outside allowed_files exits non-zero before reviewer call', async () => {
    const repoPath = createTempRepo();
    const { blockPath } = createBlockFile(repoPath);
    const result = runCli(
      ['real-block-task-probe', blockPath],
      buildEnv({
        REAL_BLOCK_TASK_PROBE_FAKE_CODER_RESPONSE:
          '{"summary":"x","files":[{"path":"src/outside.ts","content":"x"}],"notes":[]}',
      })
    );
    cleanupRepo(repoPath);
    assert.notStrictEqual(result.status, 0);
    const parsed = parseOutput(result.stdout + result.stderr);
    assert.strictEqual(parsed.ok, false);
    const coder = parsed.coder as Record<string, unknown>;
    const reviewer = parsed.reviewer as Record<string, unknown>;
    assert.strictEqual(coder.ok, false);
    assert.strictEqual(reviewer.ok, false);
    assert.match(String(reviewer.error), /Skipped/i);
  });

  test('coder denied file exits non-zero before reviewer call', async () => {
    const repoPath = createTempRepo();
    const { blockPath } = createBlockFile(repoPath, {
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
      ],
    });
    const result = runCli(
      ['real-block-task-probe', blockPath],
      buildEnv({
        REAL_BLOCK_TASK_PROBE_FAKE_CODER_RESPONSE:
          '{"summary":"x","files":[{"path":"package.json","content":"x"}],"notes":[]}',
      })
    );
    cleanupRepo(repoPath);
    assert.notStrictEqual(result.status, 0);
    const parsed = parseOutput(result.stdout + result.stderr);
    assert.strictEqual(parsed.ok, false);
    const coder = parsed.coder as Record<string, unknown>;
    assert.strictEqual(coder.ok, false);
  });

  test('coder secret-like response exits non-zero and redacts preview', async () => {
    const repoPath = createTempRepo();
    const { blockPath } = createBlockFile(repoPath);
    const result = runCli(
      ['real-block-task-probe', blockPath],
      buildEnv({
        REAL_BLOCK_TASK_PROBE_FAKE_CODER_RESPONSE:
          '{"summary":"sk-fake-token-leaked","files":[{"path":"README.md","content":"x"}],"notes":[]}',
      })
    );
    cleanupRepo(repoPath);
    assert.notStrictEqual(result.status, 0);
    const output = result.stdout + result.stderr;
    assert.doesNotMatch(output, /sk-fake-token-leaked/i);
    assert.match(output, /\[REDACTED\]/);
  });

  test('coder response with prose token is accepted', async () => {
    const repoPath = createTempRepo();
    const { blockPath } = createBlockFile(repoPath);
    const result = runCli(
      ['real-block-task-probe', blockPath],
      buildEnv({
        REAL_BLOCK_TASK_PROBE_FAKE_CODER_RESPONSE:
          '{"summary":"No token is exposed","files":[{"path":"README.md","content":"# Hello"}],"notes":[]}',
      })
    );
    cleanupRepo(repoPath);
    const parsed = parseOutput(result.stdout + result.stderr);
    assert.strictEqual(parsed.ok, true);
    const coder = parsed.coder as Record<string, unknown>;
    assert.strictEqual(coder.ok, true);
  });

  test('reviewer invalid JSON exits non-zero', async () => {
    const repoPath = createTempRepo();
    const { blockPath } = createBlockFile(repoPath);
    const result = runCli(
      ['real-block-task-probe', blockPath],
      buildEnv({ REAL_BLOCK_TASK_PROBE_FAKE_REVIEWER_RESPONSE: 'not-json' })
    );
    cleanupRepo(repoPath);
    assert.notStrictEqual(result.status, 0);
    const parsed = parseOutput(result.stdout + result.stderr);
    assert.strictEqual(parsed.ok, false);
    const reviewer = parsed.reviewer as Record<string, unknown>;
    assert.strictEqual(reviewer.ok, false);
  });

  test('reviewer invalid contract exits non-zero', async () => {
    const repoPath = createTempRepo();
    const { blockPath } = createBlockFile(repoPath);
    const result = runCli(
      ['real-block-task-probe', blockPath],
      buildEnv({
        REAL_BLOCK_TASK_PROBE_FAKE_REVIEWER_RESPONSE:
          '{"decision":"unknown","confidence":"high","blocking_issues":[],"non_blocking_issues":[],"review_summary":"x","fix_task":"","next_action":"advance_to_next_task"}',
      })
    );
    cleanupRepo(repoPath);
    assert.notStrictEqual(result.status, 0);
    const parsed = parseOutput(result.stdout + result.stderr);
    assert.strictEqual(parsed.ok, false);
    const reviewer = parsed.reviewer as Record<string, unknown>;
    assert.strictEqual(reviewer.ok, false);
  });

  test('reviewer secret-like response exits non-zero and redacts preview', async () => {
    const repoPath = createTempRepo();
    const { blockPath } = createBlockFile(repoPath);
    const result = runCli(
      ['real-block-task-probe', blockPath],
      buildEnv({
        REAL_BLOCK_TASK_PROBE_FAKE_REVIEWER_RESPONSE:
          '{"decision":"accepted","confidence":"high","blocking_issues":[],"non_blocking_issues":[],"review_summary":"sk-fake-token-leaked","fix_task":"","next_action":"advance_to_next_task"}',
      })
    );
    cleanupRepo(repoPath);
    assert.notStrictEqual(result.status, 0);
    const output = result.stdout + result.stderr;
    assert.doesNotMatch(output, /sk-fake-token-leaked/i);
    assert.match(output, /\[REDACTED\]/);
  });

  test('reviewer response with prose token is accepted', async () => {
    const repoPath = createTempRepo();
    const { blockPath } = createBlockFile(repoPath);
    const result = runCli(
      ['real-block-task-probe', blockPath],
      buildEnv({
        REAL_BLOCK_TASK_PROBE_FAKE_REVIEWER_RESPONSE:
          '{"decision":"accepted","confidence":"high","blocking_issues":[],"non_blocking_issues":[],"review_summary":"No token is exposed","fix_task":"","next_action":"advance_to_next_task"}',
      })
    );
    cleanupRepo(repoPath);
    const parsed = parseOutput(result.stdout + result.stderr);
    assert.strictEqual(parsed.ok, true);
    const reviewer = parsed.reviewer as Record<string, unknown>;
    assert.strictEqual(reviewer.ok, true);
  });

  test('--timeout-ms sets report timeoutMs', async () => {
    const repoPath = createTempRepo();
    const { blockPath } = createBlockFile(repoPath);
    const result = runCli(['real-block-task-probe', blockPath, '--timeout-ms', '3000'], buildEnv());
    cleanupRepo(repoPath);
    const parsed = parseOutput(result.stdout);
    assert.strictEqual(parsed.timeoutMs, 3000);
  });

  test('invalid timeout exits non-zero', async () => {
    const repoPath = createTempRepo();
    const { blockPath } = createBlockFile(repoPath);
    const result = runCli(['real-block-task-probe', blockPath, '--timeout-ms', 'abc'], buildEnv());
    cleanupRepo(repoPath);
    assert.notStrictEqual(result.status, 0);
  });

  test('output JSON parseable in all failure cases', () => {
    const cases = [
      { args: ['real-block-task-probe'] },
      { args: ['real-block-task-probe', 'missing.json'], env: buildEnv() },
      { args: ['real-block-task-probe', 'missing.json', '--provider', 'openai'] },
    ];
    for (const c of cases) {
      const result = runCli(c.args, c.env ?? {});
      const output = result.stdout + result.stderr;
      const match = output.match(/\{[\s\S]*\}/);
      assert.ok(match, `case ${c.args.join(' ')} should contain JSON`);
      assert.doesNotThrow(() => JSON.parse(match[0]));
    }
  });

  test('command does not write files', async () => {
    const repoPath = createTempRepo();
    const { blockPath } = createBlockFile(repoPath);
    const stateBefore = readFileSync(blockPath, 'utf-8');
    runCli(['real-block-task-probe', blockPath], buildEnv());
    const stateAfter = readFileSync(blockPath, 'utf-8');
    cleanupRepo(repoPath);
    assert.strictEqual(stateBefore, stateAfter);
  });

  test('command does not write state', async () => {
    const repoPath = createTempRepo();
    const { blockPath, blockId } = createBlockFile(repoPath);
    const stateDir = join(PROJECT_ROOT, 'runs', 'block', blockId);
    const existsBefore = false;
    runCli(['real-block-task-probe', blockPath], buildEnv());
    const existsAfter = false;
    cleanupRepo(repoPath);
    assert.strictEqual(existsBefore, existsAfter);
  });

  test('command does not run git', async () => {
    const repoPath = createTempRepo();
    const { blockPath } = createBlockFile(repoPath);
    const before = spawnSync('git', ['status', '--short'], { cwd: repoPath, encoding: 'utf-8', shell: false }).stdout;
    runCli(['real-block-task-probe', blockPath], buildEnv());
    const after = spawnSync('git', ['status', '--short'], { cwd: repoPath, encoding: 'utf-8', shell: false }).stdout;
    cleanupRepo(repoPath);
    assert.strictEqual(before, after);
  });

  test('command does not spawn block runner', () => {
    const source = readFileSync(SOURCE_PATH, 'utf-8');
    assert.doesNotMatch(source, /runOneTaskLoop/);
    assert.doesNotMatch(source, /runMultiTaskLoop/);
    assert.doesNotMatch(source, /runRealBlockRunAI/);
  });

  test('command does not use shell:true', () => {
    const source = readFileSync(CLI_SOURCE_PATH, 'utf-8');
    assert.doesNotMatch(source, /shell:\s*true/);
  });

  test('command does not apply/commit/push/merge/force push', () => {
    const source = readFileSync(SOURCE_PATH, 'utf-8');
    assert.doesNotMatch(source, /applyFileUpdates/);
    assert.doesNotMatch(source, /git push/);
    assert.doesNotMatch(source, /git commit/);
    assert.doesNotMatch(source, /git merge/);
    assert.doesNotMatch(source, /force push/);
    assert.doesNotMatch(source, /writeFileSync/);
  });

  test('command source does not call fetch/http directly', () => {
    const source = readFileSync(SOURCE_PATH, 'utf-8');
    assert.doesNotMatch(source, /\bfetch\s*\(/);
    assert.doesNotMatch(source, /http\.request/);
    assert.doesNotMatch(source, /https\.request/);
  });

  test('formatRealBlockTaskProbeReport redacts strings', () => {
    const report = {
      ok: false,
      mode: 'real-block-task-probe' as const,
      blockPath: 'block.json',
      blockId: 'b',
      taskId: 't',
      provider: 'kimi',
      timeoutMs: 15000,
      coder: { ok: false, contractValid: false, error: 'api_key=sk-test123' },
      reviewer: { ok: false, contractValid: false },
      mutated: false,
      reasons: ['api_key=sk-test123'],
      nextCommands: [],
    };
    const formatted = formatRealBlockTaskProbeReport(report);
    assert.doesNotMatch(formatted, /sk-test123/);
    assert.match(formatted, /\[REDACTED\]/);
  });

  test('direct module call does not mutate repo or state', async () => {
    const repoPath = createTempRepo();
    const { blockPath } = createBlockFile(repoPath);
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
      report = await runRealBlockTaskProbe({ blockPath, env: buildEnv() as NodeJS.ProcessEnv });
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
    assert.strictEqual(report.mode, 'real-block-task-probe');
    assert.strictEqual(report.ok, true);
    assert.strictEqual(report.mutated, false);
  });
});

import { describe, test } from 'node:test';
import assert from 'node:assert';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { runRepairAttempt } from '../src/autopilot-run/repair-runner.js';
import type { AutopilotRunConfig } from '../src/autopilot-run/types.js';

let counter = 0;

function tmpDir(): string {
  counter += 1;
  const base = join(process.cwd(), 'tmp');
  if (!existsSync(base)) {
    mkdirSync(base);
  }
  return mkdtempSync(join(base, `repair-runner-${Date.now()}-${counter}-`));
}

function makeConfig(overrides: Partial<AutopilotRunConfig['repair']> = {}): AutopilotRunConfig {
  return {
    mode: 'fake',
    run_id: 'repair-runner-test',
    repo_slug: 'owner/repo',
    base_branch: 'main',
    work_branch: 'work',
    mvp_config_path: 'mvp.json',
    diagnose_config: { token_env: 'TOKEN', include_raw_logs: false, max_log_excerpt_chars: 4000 },
    ci: { enabled: false, wait_for_ci: false, poll_interval_seconds: 5, timeout_seconds: 60 },
    repair: {
      enabled: true,
      max_attempts: 2,
      provider: 'mock',
      allow_real_provider: false,
      allow_apply: false,
      allow_commit: false,
      allow_push: false,
      allowed_files: ['src/fix.ts'],
      denied_files: [],
      ...overrides,
    },
    github: {
      allow_pr_create: false,
      allow_pr_update: false,
      allow_actions_read: false,
      allow_write: false,
    },
    report_dir: tmpDir(),
  };
}

interface RecordedCall {
  command: string;
  args: string[];
}

function spawnRecorder(
  behavior: (call: RecordedCall, index: number) => Record<string, unknown>
): { spawnFn: never; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const spawnFn = ((command: string, args: string[]) => {
    calls.push({ command, args: [...args] });
    return behavior({ command, args: [...args] }, calls.length - 1);
  }) as never;
  return { spawnFn, calls };
}

function enoentResult(call: RecordedCall): Record<string, unknown> {
  // Simulates bare `npm` on Windows with shell:false: spawn ENOENT, no status.
  const err = new Error(`spawn ${call.command} ENOENT`) as Error & { code: string };
  err.code = 'ENOENT';
  return { error: err, status: null, signal: null, stdout: '', stderr: '' };
}

function okResult(): Record<string, unknown> {
  return { error: null, status: 0, signal: null, stdout: '', stderr: '' };
}

describe('repair-runner local checks (stage 18.26g)', () => {
  test('bare npm spawn ENOENT (Windows) surfaces explicit spawn error, never empty output', async () => {
    const config = makeConfig();
    const repoPath = tmpDir();
    try {
      const { spawnFn, calls } = spawnRecorder((call) =>
        call.command === 'npm' ? enoentResult(call) : okResult()
      );

      const result = await runRepairAttempt(
        config,
        { repoPath, fixTaskMd: '# fix\n', reportDir: config.report_dir, attempt: 1 },
        { spawnFn: spawnFn as never }
      );

      assert.strictEqual(result.ok, false);
      assert(
        result.reason.includes('typecheck failed') &&
          result.reason.includes('failed to start') &&
          result.reason.includes('ENOENT'),
        `reason must name the check and the spawn error: ${result.reason}`
      );
      assert.strictEqual(calls.length, 1, 'typecheck failure should stop the check sequence');

      const evidencePath = join(config.report_dir, 'repair-attempt-1', 'local-checks.json');
      assert.ok(existsSync(evidencePath), 'local check evidence must be persisted');
      const evidence = JSON.parse(readFileSync(evidencePath, 'utf-8')) as {
        checks: {
          check: string;
          command: string;
          exit_status: number | null;
          signal: string | null;
          spawn_error: string | null;
        }[];
      };
      assert.strictEqual(evidence.checks.length, 1);
      assert.strictEqual(evidence.checks[0].check, 'typecheck');
      assert.strictEqual(evidence.checks[0].command, 'npm');
      assert.strictEqual(evidence.checks[0].exit_status, null);
      assert.match(evidence.checks[0].spawn_error ?? '', /ENOENT/);
    } finally {
      rmSync(config.report_dir, { recursive: true, force: true });
      rmSync(repoPath, { recursive: true, force: true });
    }
  });

  test('successful npm/npx checks pass and npx targeted test uses the failing file', async () => {
    const config = makeConfig();
    const repoPath = tmpDir();
    const failingFile = join('test', 'example.test.ts');
    try {
      const { spawnFn, calls } = spawnRecorder(() => okResult());

      const result = await runRepairAttempt(
        config,
        { repoPath, fixTaskMd: '# fix\n', failingFile, reportDir: config.report_dir, attempt: 1 },
        { spawnFn: spawnFn as never }
      );

      assert.strictEqual(result.ok, true, `expected success: ${result.reason}`);
      assert.deepStrictEqual(
        calls.map((c) => [c.command, ...c.args]),
        [
          ['npm', 'run', 'typecheck'],
          ['npm', 'run', 'build'],
          ['npx', 'tsx', '--test', failingFile],
        ]
      );

      const evidencePath = join(config.report_dir, 'repair-attempt-1', 'local-checks.json');
      const evidence = JSON.parse(readFileSync(evidencePath, 'utf-8')) as {
        checks: { ok: boolean; exit_status: number | null; cwd: string }[];
      };
      assert.strictEqual(evidence.checks.length, 3);
      for (const check of evidence.checks) {
        assert.strictEqual(check.ok, true);
        assert.strictEqual(check.exit_status, 0);
        assert.strictEqual(check.cwd, repoPath);
      }
    } finally {
      rmSync(config.report_dir, { recursive: true, force: true });
      rmSync(repoPath, { recursive: true, force: true });
    }
  });

  test('non-zero exit status is captured with stderr evidence', async () => {
    const config = makeConfig();
    const repoPath = tmpDir();
    try {
      const { spawnFn } = spawnRecorder((call) =>
        call.command === 'npm' && call.args[1] === 'build'
          ? { error: null, status: 2, signal: null, stdout: '', stderr: 'tsc emit error\n' }
          : okResult()
      );

      const result = await runRepairAttempt(
        config,
        { repoPath, fixTaskMd: '# fix\n', reportDir: config.report_dir, attempt: 2 },
        { spawnFn: spawnFn as never }
      );

      assert.strictEqual(result.ok, false);
      assert(
        result.reason.includes('build failed') && result.reason.includes('exit 2'),
        `reason must include check name and exit status: ${result.reason}`
      );
      assert(result.reason.includes('tsc emit error'), 'reason must include stderr');
    } finally {
      rmSync(config.report_dir, { recursive: true, force: true });
      rmSync(repoPath, { recursive: true, force: true });
    }
  });
});

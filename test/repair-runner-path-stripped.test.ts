import { describe, test } from 'node:test';
import assert from 'node:assert';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { runRepairAttempt } from '../src/autopilot-run/repair-runner.js';
import type { AutopilotRunConfig } from '../src/autopilot-run/types.js';

/**
 * Stage 18.26h — real PATH-stripped regression, stronger than the 18.26g
 * ENOENT simulation.
 *
 * The environment is Windows-style: bare `npm`/`npx` CANNOT be resolved
 * (PATH is empty), but process.execPath exists, the absolute npm CLI exists
 * and the local tsx CLI exists. Expected: typecheck, build and the targeted
 * test ACTUALLY EXECUTE successfully with real child processes — no bare
 * npm/npx lookup is required.
 */
let counter = 0;

function tmpDir(): string {
  counter += 1;
  const base = join(process.cwd(), 'tmp');
  if (!existsSync(base)) {
    mkdirSync(base);
  }
  return mkdtempSync(join(base, `repair-path-stripped-${Date.now()}-${counter}-`));
}

function makeConfig(reportDir: string): AutopilotRunConfig {
  return {
    mode: 'fake',
    run_id: 'repair-path-stripped-test',
    repo_slug: 'owner/repo',
    base_branch: 'main',
    work_branch: 'work',
    mvp_config_path: 'mvp.json',
    diagnose_config: { token_env: 'TOKEN', include_raw_logs: false, max_log_excerpt_chars: 4000 },
    ci: { enabled: false, wait_for_ci: false, poll_interval_seconds: 5, timeout_seconds: 60 },
    repair: {
      enabled: true,
      max_attempts: 1,
      provider: 'mock',
      allow_real_provider: false,
      allow_apply: false,
      allow_commit: false,
      allow_push: false,
      allowed_files: ['src/fix.ts'],
      denied_files: [],
    },
    github: {
      allow_pr_create: false,
      allow_pr_update: false,
      allow_actions_read: false,
      allow_write: false,
    },
    report_dir: reportDir,
  };
}

/** Locate the real npm CLI entry script the same way the resolver does. */
function findRealNpmCli(): string | undefined {
  const candidates = [
    process.env.npm_execpath,
    join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ];
  for (const candidate of candidates) {
    if (
      typeof candidate === 'string' &&
      candidate.length > 0 &&
      isAbsolute(candidate) &&
      /\.(?:js|mjs|cjs)$/i.test(candidate) &&
      existsSync(candidate)
    ) {
      return candidate;
    }
  }
  return undefined;
}

describe('repair-runner PATH-stripped real execution (stage 18.26h)', () => {
  test('typecheck/build/targeted test execute via absolute Node/npm tooling with empty PATH', async () => {
    const npmCli = findRealNpmCli();
    assert.ok(npmCli, 'test requires a resolvable absolute npm CLI (run tests under npm)');

    const reportDir = tmpDir();
    const repoPath = tmpDir();
    try {
      // Minimal repository: scripts are shell builtins so they need no PATH.
      writeFileSync(
        join(repoPath, 'package.json'),
        JSON.stringify({
          name: 'path-stripped-repo',
          version: '0.0.1',
          scripts: {
            typecheck: 'echo typecheck-ok',
            build: 'echo build-ok',
          },
        }),
        'utf-8'
      );
      mkdirSync(join(repoPath, 'test'));
      writeFileSync(
        join(repoPath, 'test', 'sample.test.ts'),
        "import { test } from 'node:test';\nimport assert from 'node:assert';\n" +
          "test('sample', () => { assert.strictEqual(1, 1); });\n",
        'utf-8'
      );

      // Windows-style stripped environment: nothing on PATH, so bare
      // npm/npx are unresolvable; absolute paths must carry everything.
      const strippedEnv: NodeJS.ProcessEnv = {
        PATH: '',
        Path: '',
        npm_execpath: npmCli,
        SystemRoot: process.env.SystemRoot,
        COMSPEC: process.env.COMSPEC,
        HOME: process.env.HOME,
        USERPROFILE: process.env.USERPROFILE,
        TEMP: process.env.TEMP,
        TMP: process.env.TMP,
      };

      const result = await runRepairAttempt(
        makeConfig(reportDir),
        {
          repoPath,
          fixTaskMd: '# fix\n',
          failingFile: join('test', 'sample.test.ts'),
          reportDir,
          attempt: 1,
        },
        { tooling: { env: strippedEnv } }
      );

      assert.strictEqual(result.ok, true, `expected success in PATH-stripped env: ${result.reason}`);

      const evidence = JSON.parse(
        readFileSync(join(reportDir, 'repair-attempt-1', 'local-checks.json'), 'utf-8')
      ) as {
        checks: {
          check: string;
          command: string;
          args: string[];
          ok: boolean;
          exit_status: number | null;
          spawn_error: string | null;
          stdout: string;
        }[];
      };

      assert.strictEqual(evidence.checks.length, 3);
      const [typecheck, build, targeted] = evidence.checks;
      for (const check of evidence.checks) {
        assert.strictEqual(check.ok, true, `${check.check} must actually execute`);
        assert.strictEqual(check.exit_status, 0, `${check.check} must exit 0`);
        assert.strictEqual(check.spawn_error, null);
        assert.strictEqual(check.command, process.execPath, 'must run via absolute node');
      }
      assert.deepStrictEqual(typecheck.args.slice(0, 3), [npmCli, 'run', 'typecheck']);
      assert.deepStrictEqual(build.args.slice(0, 3), [npmCli, 'run', 'build']);
      assert.match(targeted.args[0], /tsx[/\\]dist[/\\]cli\.mjs$/, 'targeted test uses the local tsx CLI');
      assert.strictEqual(targeted.args[1], '--test');
    } finally {
      rmSync(reportDir, { recursive: true, force: true });
      rmSync(repoPath, { recursive: true, force: true });
    }
  });
});

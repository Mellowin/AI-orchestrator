import { describe, test } from 'node:test';
import assert from 'node:assert';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { runDiagnoseCi } from '../src/diagnose-ci/runner.js';
import type { DiagnoseCiConfig } from '../src/diagnose-ci/types.js';

let counter = 0;

function makeConfig(overrides: Partial<DiagnoseCiConfig> = {}): DiagnoseCiConfig {
  counter += 1;
  const base = join(process.cwd(), 'tmp');
  if (!existsSync(base)) {
    mkdirSync(base);
  }
  return {
    mode: 'github',
    run_id: 'skipped-job-regression',
    repo_slug: 'owner/repo',
    target: { workflow_run_id: 36010759265 },
    token_env: 'DIAGNOSE_CI_SKIPPED_JOB_TOKEN',
    report_dir: mkdtempSync(join(base, `diagnose-ci-skipped-${Date.now()}-${counter}-`)),
    include_raw_logs: false,
    max_log_excerpt_chars: 8000,
    allow_github_write: false,
    ...overrides,
  };
}

function cleanup(dir: string): void {
  if (existsSync(dir)) {
    rmSync(dir, { recursive: true, force: true });
  }
}

const FAILING_TEST_NAME = 'REAL_BLOCK_RUN_RESUME=1 env flag enables resume after timeout';

const CHECKS_LOG = [
  'Run npm test',
  `# Subtest: ${FAILING_TEST_NAME}`,
  `not ok 1 - ${FAILING_TEST_NAME}`,
  '  ---',
  '  duration_ms: 2000',
  "  location: 'test/cli-real-block-run-ai.test.ts:1345:3'",
  "  failureType: 'testCodeFailure'",
  '  error: |-',
  '    Expected resume success',
  "  code: 'ERR_ASSERTION'",
  '  actual: 1',
  '  expected: 0',
  '  ...',
  'FAILED: one or more test chunks failed.',
  'TOTAL: tests=4206 suites=332 pass=4205 fail=1 cancelled=0 skipped=0',
].join('\n');

function makeFetchFn(options: { skippedJobLogsStatus: number; checksJobLogsStatus?: number }) {
  return async (url: string | URL): Promise<Response> => {
    const urlString = url.toString();
    if (urlString.includes('/actions/runs/36010759265/jobs')) {
      return new Response(
        JSON.stringify({
          jobs: [
            {
              id: 107670547590,
              name: 'checks',
              status: 'completed',
              conclusion: 'failure',
              steps: [
                { number: 1, name: 'Checkout repository', status: 'completed', conclusion: 'success' },
                { number: 2, name: 'Setup Node.js', status: 'completed', conclusion: 'success' },
                { number: 3, name: 'Install dependencies', status: 'completed', conclusion: 'success' },
                { number: 4, name: 'Type check', status: 'completed', conclusion: 'success' },
                { number: 5, name: 'Build', status: 'completed', conclusion: 'success' },
                { number: 6, name: 'Test', status: 'completed', conclusion: 'failure' },
              ],
            },
            {
              id: 107676488327,
              name: 'post-push-follow-up-drill-smoke',
              status: 'completed',
              conclusion: 'skipped',
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }
    if (urlString.includes('/actions/runs/36010759265')) {
      return new Response(
        JSON.stringify({
          id: 36010759265,
          run_number: 42,
          name: 'Mini-MVP CI',
          event: 'pull_request',
          head_branch: 'stage-18-26-autonomous-multitask-completion',
          head_sha: 'b869e66b0de88c0f03ceb29efa6e7bb29a292a',
          status: 'completed',
          conclusion: 'failure',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }
    if (urlString.includes('/actions/jobs/107670547590/logs')) {
      const status = options.checksJobLogsStatus ?? 200;
      if (status === 200) {
        return new Response(CHECKS_LOG, { status: 200, headers: { 'content-type': 'text/plain' } });
      }
      return new Response(JSON.stringify({ message: 'Not Found' }), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (urlString.includes('/actions/jobs/107676488327/logs')) {
      // GitHub returns 404/BlobNotFound for logs of a skipped job.
      return new Response(JSON.stringify({ message: 'BlobNotFound' }), {
        status: options.skippedJobLogsStatus,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({ message: 'not found' }), {
      status: 404,
      headers: { 'content-type': 'application/json' },
    });
  };
}

describe('diagnose-ci skipped-job log regression (stage 18.26g)', () => {
  test('failed checks job + skipped job with 404 logs: diagnosis continues with real failing test evidence', async () => {
    const config = makeConfig();
    process.env[config.token_env] = 'ghp_skippedjobregressiontoken0123456789012345';
    try {
      const result = await runDiagnoseCi(config, {
        fetchFn: makeFetchFn({ skippedJobLogsStatus: 404 }) as typeof fetch,
      });

      assert.strictEqual(result.verdict, 'DIAGNOSE_CI_RED');
      assert.strictEqual(result.classification, 'TEST_FAILURE');
      assert.ok(result.report_paths, 'expected report paths');

      const fixTaskMd = readFileSync(result.report_paths!.fix_task_md, 'utf-8');
      assert(
        fixTaskMd.includes(FAILING_TEST_NAME),
        `fix task must name the real failing test: ${fixTaskMd}`
      );
      assert(
        fixTaskMd.includes('cli-real-block-run-ai.test.ts'),
        `fix task must name the failing file: ${fixTaskMd}`
      );

      const reportMd = readFileSync(result.report_paths!.report_md, 'utf-8');
      assert(
        reportMd.includes('Unavailable Job Logs'),
        'report must record unavailable job log evidence'
      );
      assert(
        reportMd.includes('post-push-follow-up-drill-smoke'),
        'report must name the skipped job: ' + reportMd
      );

      const reportJson = JSON.parse(readFileSync(result.report_paths!.report_json, 'utf-8')) as {
        parse_result: { unavailable_job_logs: { job_id: number; job_name: string; status?: number }[] };
      };
      const unavailable = reportJson.parse_result.unavailable_job_logs;
      assert.strictEqual(unavailable.length, 1);
      assert.strictEqual(unavailable[0].job_id, 107676488327);
      assert.strictEqual(unavailable[0].status, 404);
    } finally {
      delete process.env[config.token_env];
      cleanup(config.report_dir);
    }
  });

  test('failed job logs unavailable with no other failed job logs: fail closed as NOT_FOUND', async () => {
    const config = makeConfig();
    process.env[config.token_env] = 'ghp_skippedjobregressiontoken0123456789012345';
    try {
      const result = await runDiagnoseCi(config, {
        fetchFn: makeFetchFn({ skippedJobLogsStatus: 404, checksJobLogsStatus: 404 }) as typeof fetch,
      });
      assert.strictEqual(result.verdict, 'DIAGNOSE_CI_NOT_FOUND');
      assert.strictEqual(result.run_id, null);
    } finally {
      delete process.env[config.token_env];
      cleanup(config.report_dir);
    }
  });

  test('job logs endpoint auth failure (403) still fails closed as ACCESS_ERROR', async () => {
    const config = makeConfig();
    process.env[config.token_env] = 'ghp_skippedjobregressiontoken0123456789012345';
    try {
      const result = await runDiagnoseCi(config, {
        fetchFn: makeFetchFn({ skippedJobLogsStatus: 403 }) as typeof fetch,
      });
      assert.strictEqual(result.verdict, 'DIAGNOSE_CI_ACCESS_ERROR');
    } finally {
      delete process.env[config.token_env];
      cleanup(config.report_dir);
    }
  });
});

import { describe, test } from 'node:test';
import assert from 'node:assert';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { runDiagnoseCi } from '../src/diagnose-ci/runner.js';
import { resolveWorkflowRunId } from '../src/diagnose-ci/github-client.js';
import type { DiagnoseCiConfig } from '../src/diagnose-ci/types.js';

let counter = 0;

function tmpDir(): string {
  const id = `${Date.now()}-${counter++}`;
  const base = join(process.cwd(), 'tmp');
  if (!existsSync(base)) {
    mkdirSync(base);
  }
  return mkdtempSync(join(base, `diagnose-ci-runner-${id}-`));
}

function makeConfig(overrides: Partial<DiagnoseCiConfig> = {}): DiagnoseCiConfig {
  return {
    mode: 'fake',
    run_id: 'test-run',
    repo_slug: 'owner/repo',
    target: { workflow_run_id: 123456789 },
    token_env: 'DIAGNOSE_CI_TEST_TOKEN',
    report_dir: tmpDir(),
    include_raw_logs: false,
    max_log_excerpt_chars: 4000,
    allow_github_write: false,
    fake_scenario: 'green',
    ...overrides,
  };
}

function cleanup(dir: string): void {
  if (existsSync(dir)) {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('diagnose-ci runner', () => {
  test('fake green returns DIAGNOSE_CI_GREEN and writes report/fix-task', async () => {
    const config = makeConfig({ fake_scenario: 'green' });
    try {
      const result = await runDiagnoseCi(config, { command: 'test:diagnose-ci-green' });

      assert.strictEqual(result.verdict, 'DIAGNOSE_CI_GREEN');
      assert.strictEqual(result.run_id, 123456789);
      assert.strictEqual(result.classification, 'CI_GREEN');
      assert.ok(result.report_paths, 'expected report paths');
      assert.ok(existsSync(result.report_paths!.report_md));
      assert.ok(existsSync(result.report_paths!.report_json));
      assert.ok(existsSync(result.report_paths!.fix_task_md));
      assert.ok(existsSync(result.report_paths!.fix_task_json));
    } finally {
      cleanup(config.report_dir);
    }
  });

  test('fake red returns DIAGNOSE_CI_RED and writes report/fix-task', async () => {
    const config = makeConfig({ fake_scenario: 'red' });
    try {
      const result = await runDiagnoseCi(config, { command: 'test:diagnose-ci-red' });

      assert.strictEqual(result.verdict, 'DIAGNOSE_CI_RED');
      assert.strictEqual(result.run_id, 123456789);
      assert.ok(result.classification !== 'CI_GREEN');
      assert.ok(result.report_paths, 'expected report paths');
      assert.ok(existsSync(result.report_paths!.report_md));
      assert.ok(existsSync(result.report_paths!.report_json));
      assert.ok(existsSync(result.report_paths!.fix_task_md));
      assert.ok(existsSync(result.report_paths!.fix_task_json));
    } finally {
      cleanup(config.report_dir);
    }
  });

  test('github mode without token returns DIAGNOSE_CI_NEEDS_TOKEN', async () => {
    const config = makeConfig({
      mode: 'github',
      token_env: 'DIAGNOSE_CI_EMPTY_TOKEN_FOR_TEST',
    });
    delete process.env[config.token_env];
    try {
      const result = await runDiagnoseCi(config);
      assert.strictEqual(result.verdict, 'DIAGNOSE_CI_NEEDS_TOKEN');
      assert.strictEqual(result.run_id, null);
    } finally {
      cleanup(config.report_dir);
    }
  });

  test('target priority: workflow_run_id > pr_number > commit_sha', async () => {
    const configWorkflow = makeConfig({
      mode: 'github',
      target: {
        workflow_run_id: 111,
        pr_number: 222,
        commit_sha: 'deadbeef',
      },
    });
    delete process.env[configWorkflow.token_env];

    const fetchFn = () => {
      throw new Error('fetch should not be called when workflow_run_id is present');
    };

    try {
      const resolved = await resolveWorkflowRunId(configWorkflow, fetchFn as typeof fetch);
      assert.strictEqual(resolved.runId, 111);
      assert.strictEqual(resolved.source, 'workflow_run_id');
    } finally {
      cleanup(configWorkflow.report_dir);
    }
  });

  test('no GitHub write endpoints are called', async () => {
    const token = 'ghp_testtoken_norealnetwork';
    const config = makeConfig({
      mode: 'github',
      token_env: 'DIAGNOSE_CI_WRITE_TEST_TOKEN',
      target: { workflow_run_id: 111 },
    });
    process.env[config.token_env] = token;

    const calls: { url: string; method?: string }[] = [];

    const fetchFn = async (url: string | URL | Request, init?: RequestInit) => {
      const urlString = url.toString();
      const method = init?.method ?? 'GET';
      calls.push({ url: urlString, method });

      if (method !== 'GET') {
        return new Response(JSON.stringify({ message: 'write not allowed' }), {
          status: 405,
          headers: { 'content-type': 'application/json' },
        });
      }

      if (urlString.includes('/actions/runs/111')) {
        return new Response(
          JSON.stringify({
            id: 111,
            run_number: 1,
            name: 'CI',
            event: 'push',
            head_branch: 'main',
            head_sha: 'abc123',
            status: 'completed',
            conclusion: 'success',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }

      if (urlString.includes('/actions/runs/111/jobs')) {
        return new Response(
          JSON.stringify({
            jobs: [
              {
                id: 999,
                name: 'checks',
                status: 'completed',
                conclusion: 'success',
                steps: [{ number: 1, name: 'Test', status: 'completed', conclusion: 'success' }],
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }

      if (urlString.includes('/actions/jobs/999/logs')) {
        return new Response('all green', { status: 200, headers: { 'content-type': 'text/plain' } });
      }

      return new Response(JSON.stringify({ message: 'not found' }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      });
    };

    try {
      const result = await runDiagnoseCi(config, { fetchFn: fetchFn as typeof fetch });
      assert.strictEqual(result.verdict, 'DIAGNOSE_CI_GREEN');
      assert.ok(calls.length > 0, 'expected at least one GitHub API call');
      for (const call of calls) {
        assert.strictEqual(call.method, 'GET', `expected only GET calls, got ${call.method} ${call.url}`);
        assert.ok(
          /\/actions\/(runs|jobs)\//.test(call.url) || /\/repos\/owner\/repo\/actions\//.test(call.url),
          `unexpected endpoint ${call.url}`
        );
      }
    } finally {
      delete process.env[config.token_env];
      cleanup(config.report_dir);
    }
  });

  test('reports do not contain raw token', async () => {
    const token = 'ghp_reportleaktest_123456789012345678901234567890123456';
    const config = makeConfig({
      mode: 'github',
      token_env: 'DIAGNOSE_CI_REDACT_TOKEN',
      target: { workflow_run_id: 111 },
    });
    process.env[config.token_env] = token;

    const fetchFn = async (url: string | URL | Request) => {
      const urlString = url.toString();
      if (urlString.includes('/actions/runs/111')) {
        return new Response(
          JSON.stringify({
            id: 111,
            run_number: 1,
            name: 'CI',
            event: 'push',
            head_branch: 'main',
            head_sha: 'abc123',
            status: 'completed',
            conclusion: 'failure',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      if (urlString.includes('/actions/runs/111/jobs')) {
        return new Response(
          JSON.stringify({
            jobs: [
              {
                id: 999,
                name: 'checks',
                status: 'completed',
                conclusion: 'failure',
                steps: [{ number: 1, name: 'Test', status: 'completed', conclusion: 'failure' }],
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      if (urlString.includes('/actions/jobs/999/logs')) {
        return new Response(
          `Authorization: token ${token}\nError: test failed`,
          { status: 200, headers: { 'content-type': 'text/plain' } }
        );
      }
      return new Response(JSON.stringify({ message: 'not found' }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      });
    };

    try {
      const result = await runDiagnoseCi(config, { fetchFn: fetchFn as typeof fetch });
      assert.strictEqual(result.verdict, 'DIAGNOSE_CI_RED');
      assert.ok(result.report_paths, 'expected report paths');

      const md = readFileSync(result.report_paths!.report_md, 'utf-8');
      const json = readFileSync(result.report_paths!.report_json, 'utf-8');
      const fixTaskMd = readFileSync(result.report_paths!.fix_task_md, 'utf-8');
      const fixTaskJson = readFileSync(result.report_paths!.fix_task_json, 'utf-8');

      assert.ok(!md.includes(token), 'report.md leaked token');
      assert.ok(!json.includes(token), 'report.json leaked token');
      assert.ok(!fixTaskMd.includes(token), 'fix-task.md leaked token');
      assert.ok(!fixTaskJson.includes(token), 'fix-task.json leaked token');
    } finally {
      delete process.env[config.token_env];
      cleanup(config.report_dir);
    }
  });
});

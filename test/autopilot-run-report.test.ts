import { describe, test } from 'node:test';
import assert from 'node:assert';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { writeAutopilotReports, getAutopilotReportDir } from '../src/autopilot-run/report-writer.js';
import { createTimeline, addTimelineEvent } from '../src/autopilot-run/timeline-writer.js';
import { buildCapabilitySummary } from '../src/autopilot-run/env-validator.js';
import type { AutopilotRunConfig, AutopilotRunResult } from '../src/autopilot-run/types.js';

let counter = 0;

function tmpDir(): string {
  const id = `${Date.now()}-${counter++}`;
  const base = join(process.cwd(), 'tmp');
  if (!existsSync(base)) {
    mkdirSync(base);
  }
  return mkdtempSync(join(base, `autopilot-report-${id}-`));
}

function baseConfig(reportDir: string): AutopilotRunConfig {
  return {
    mode: 'fake',
    run_id: 'report-test',
    repo_slug: 'owner/repo',
    base_branch: 'main',
    work_branch: 'autopilot-report',
    mvp_config_path: 'configs/mvp-run.example.json',
    diagnose_config: {
      token_env: 'GITHUB_TOKEN',
      include_raw_logs: false,
      max_log_excerpt_chars: 4000,
    },
    ci: {
      enabled: false,
      wait_for_ci: false,
      poll_interval_seconds: 15,
      timeout_seconds: 900,
    },
    repair: {
      enabled: false,
      max_attempts: 2,
      provider: 'mock',
      allow_real_provider: false,
      allow_apply: true,
      allow_commit: false,
      allow_push: false,
      denied_files: ['.env*'],
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

function baseResult(config: AutopilotRunConfig): AutopilotRunResult {
  return {
    config,
    command: 'test',
    config_path: '/tmp/config.json',
    started_at: new Date().toISOString(),
    finished_at: new Date().toISOString(),
    duration_ms: 100,
    verdict: 'AUTOPILOT_MVP_DONE_CI_NOT_OBSERVED',
    reason: 'MVP passed; CI not observed',
    repair_attempts: 0,
    report_dir: getAutopilotReportDir(config.report_dir, config.run_id),
    exit_code: 0,
  };
}

describe('autopilot-run report-writer', () => {
  test('writes report.md, report.json, and timeline.json', () => {
    const reportDir = tmpDir();
    const config = baseConfig(reportDir);
    const result = baseResult(config);
    const capabilities = buildCapabilitySummary(config);
    const timeline = createTimeline();
    addTimelineEvent(timeline, 'preflight');
    addTimelineEvent(timeline, 'mvp_completed', { verdict: 'MVP_RUN_PASSED' });

    try {
      writeAutopilotReports(result, capabilities, timeline);
      const autopilotDir = result.report_dir;
      assert.ok(existsSync(join(autopilotDir, 'report.md')));
      assert.ok(existsSync(join(autopilotDir, 'report.json')));

      const md = readFileSync(join(autopilotDir, 'report.md'), 'utf-8');
      assert.ok(md.includes('Autopilot Run Report'));
      assert.ok(md.includes('AUTOPILOT_MVP_DONE_CI_NOT_OBSERVED'));
      assert.ok(md.includes('repo.apply.write'));
      assert.ok(md.includes('github.merge'));

      const json = JSON.parse(readFileSync(join(autopilotDir, 'report.json'), 'utf-8')) as Record<string, unknown>;
      assert.strictEqual(json.verdict, 'AUTOPILOT_MVP_DONE_CI_NOT_OBSERVED');
      assert.strictEqual((json as { result: { config: { mvp_config_path: string } } }).result.config.mvp_config_path, '[REDACTED]');
    } finally {
      rmSync(reportDir, { recursive: true, force: true });
    }
  });

  test('redacts secrets from reports', () => {
    const reportDir = tmpDir();
    const config = baseConfig(reportDir);
    const result: AutopilotRunResult = {
      ...baseResult(config),
      reason: 'Token ghp_test12345 leaked in logs',
    };
    const capabilities = buildCapabilitySummary(config);
    const timeline = createTimeline();

    try {
      writeAutopilotReports(result, capabilities, timeline);
      const md = readFileSync(join(result.report_dir, 'report.md'), 'utf-8');
      const json = readFileSync(join(result.report_dir, 'report.json'), 'utf-8');
      assert.ok(!md.includes('ghp_test12345'), 'report.md leaked token');
      assert.ok(!json.includes('ghp_test12345'), 'report.json leaked token');
    } finally {
      rmSync(reportDir, { recursive: true, force: true });
    }
  });
});

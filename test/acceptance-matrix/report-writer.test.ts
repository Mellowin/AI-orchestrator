import { describe, test } from 'node:test';
import assert from 'node:assert';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { writeAcceptanceMatrixReports } from '../../src/acceptance-matrix/report-writer.js';
import type { AcceptanceMatrixResult } from '../../src/acceptance-matrix/types.js';

let counter = 0;

function makeResult(): AcceptanceMatrixResult {
  const id = `${Date.now()}-${counter++}`;
  const reportDir = mkdtempSync(join(process.cwd(), 'tmp', `am-rpt-${id}-`));
  return {
    config: {
      provider: 'fake',
      allow_real_provider: false,
      allow_github_pr_create: false,
      stop_on_orchestrator_bug: true,
      report_dir: reportDir,
      sandbox_repo_path: '/secret/path',
      sandbox_repo_slug: 'owner/repo',
      scenarios: [
        {
          type: 'golden_real_multitask',
          label: 'Golden',
          base_branch: 'main',
          work_branch: 'am-golden',
          unsafe_response_mode: 'none',
        },
      ],
    },
    started_at: '2026-01-01T00:00:00.000Z',
    finished_at: '2026-01-01T00:00:01.000Z',
    duration_ms: 1000,
    summary: { total: 1, passed: 1, passed_with_caveats: 0, failed: 0, skipped: 0 },
    results: [
      {
        type: 'golden_real_multitask',
        label: 'Golden',
        status: 'passed',
        expected: true,
        reason: 'All tasks completed',
        evidence_dir: join(reportDir, 'scenario-1'),
        duration_ms: 900,
      },
    ],
    report_dir: reportDir,
    orchestrator_exit_code: 0,
  };
}

describe('acceptance-matrix report-writer', () => {
  test('writes JSON and Markdown reports', () => {
    const result = makeResult();
    try {
      writeAcceptanceMatrixReports(result);
      assert.ok(existsSync(join(result.report_dir, 'acceptance-matrix-result.json')));
      assert.ok(existsSync(join(result.report_dir, 'acceptance-matrix-report.md')));
    } finally {
      rmSync(result.report_dir, { recursive: true, force: true });
    }
  });

  test('redacts sandbox path from JSON report', () => {
    const result = makeResult();
    try {
      writeAcceptanceMatrixReports(result);
      const raw = readFileSync(join(result.report_dir, 'acceptance-matrix-result.json'), 'utf-8');
      assert.ok(!raw.includes('/secret/path'));
      assert.ok(raw.includes('[REDACTED]'));
    } finally {
      rmSync(result.report_dir, { recursive: true, force: true });
    }
  });

  test('markdown contains scenario summary and token disclaimer', () => {
    const result = makeResult();
    try {
      writeAcceptanceMatrixReports(result);
      const md = readFileSync(join(result.report_dir, 'acceptance-matrix-report.md'), 'utf-8');
      assert.ok(md.includes('Acceptance Matrix Report'));
      assert.ok(md.includes('Golden'));
      assert.ok(md.includes('Passed: 1'));
      assert.ok(md.includes('No token values are included'));
    } finally {
      rmSync(result.report_dir, { recursive: true, force: true });
    }
  });
});

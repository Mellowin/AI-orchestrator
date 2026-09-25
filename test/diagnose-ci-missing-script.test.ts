import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyRun } from '../src/diagnose-ci/classifier.js';
import { parseLog } from '../src/diagnose-ci/log-parser.js';
import type { DiagnoseCiJob, DiagnoseCiJobEvidence, DiagnoseCiWorkflowRun } from '../src/diagnose-ci/types.js';

/**
 * Stage 18.26h — exact real-failure regression (mission-20260924-202258-multitask-workflow-a,
 * PR #84, CI run 36035346642):
 *
 *   checks job                  -> SUCCESS, but its logs contain timeout-like text from tests
 *   rollback-drill-smoke        -> FAILURE, "npm error Missing script: demo:rollback-policy-drill"
 *   post-push-follow-up-drill   -> FAILURE, "npm error Missing script: demo:post-push-follow-up-drill"
 *   block-follow-up-drill-smoke -> FAILURE, "npm error Missing script: demo:block-follow-up-drill"
 *
 * Expected: NOT CI_TIMEOUT; classification = MISSING_NPM_SCRIPT; all three
 * missing scripts extracted; timeout text from the successful job ignored.
 */

const CHECKS_LOG = [
  'Type check = success',
  'Build = success',
  'Test = success',
  '# Subtest: slow polling test',
  'ok 1 slow polling test',
  'not ok 2 slow dependency watch # time=30001ms',
  'test worker timed out after 30000ms and was cancelled',
  '# TOTAL: tests=4212 suites=334 pass=4211 fail=1 cancelled=1 skipped=0',
  'Verify TESTING_SUMMARY evidence = success',
].join('\n');

const DRILL_LOGS: Record<string, string> = {
  'rollback-drill-smoke':
    'npm error Missing script: "demo:rollback-policy-drill"\n' +
    'npm error A complete log of this run can be found in: /home/runner/.npm/_logs/debug.log\n',
  'post-push-follow-up-drill-smoke':
    'npm error Missing script: "demo:post-push-follow-up-drill"\n',
  'block-follow-up-drill-smoke':
    'npm error Missing script: "demo:block-follow-up-drill"\n',
};

const RUN: DiagnoseCiWorkflowRun = {
  id: 36035346642,
  run_number: 42,
  name: 'Mini-MVP CI',
  event: 'pull_request',
  branch: 'mission-20260924-202258-multitask-workflow-a',
  head_sha: '7cfd2396f596d9959231bb5cf08067b02f2dfe01',
  status: 'completed',
  conclusion: 'failure',
};

const JOBS: DiagnoseCiJob[] = [
  {
    id: 107753923119,
    name: 'checks',
    status: 'completed',
    conclusion: 'success',
    steps: [
      { name: 'Type check', status: 'completed', conclusion: 'success' },
      { name: 'Build', status: 'completed', conclusion: 'success' },
      { name: 'Test', status: 'completed', conclusion: 'success' },
      { name: 'Verify TESTING_SUMMARY evidence', status: 'completed', conclusion: 'success' },
    ],
  },
  {
    id: 107757395682,
    name: 'rollback-drill-smoke',
    status: 'completed',
    conclusion: 'failure',
    steps: [
      { name: 'Install dependencies', status: 'completed', conclusion: 'success' },
      { name: 'Rollback policy drill smoke', status: 'completed', conclusion: 'failure' },
    ],
  },
  {
    id: 107757395740,
    name: 'post-push-follow-up-drill-smoke',
    status: 'completed',
    conclusion: 'failure',
    steps: [
      { name: 'Install dependencies', status: 'completed', conclusion: 'success' },
      { name: 'Post-push follow-up drill smoke', status: 'completed', conclusion: 'failure' },
    ],
  },
  {
    id: 107757395782,
    name: 'block-follow-up-drill-smoke',
    status: 'completed',
    conclusion: 'failure',
    steps: [
      { name: 'Install dependencies', status: 'completed', conclusion: 'success' },
      { name: 'Block follow-up drill smoke', status: 'completed', conclusion: 'failure' },
    ],
  },
];

function buildJobEvidence(): DiagnoseCiJobEvidence[] {
  const logs: Record<number, string> = {
    107753923119: CHECKS_LOG,
    107757395682: DRILL_LOGS['rollback-drill-smoke'],
    107757395740: DRILL_LOGS['post-push-follow-up-drill-smoke'],
    107757395782: DRILL_LOGS['block-follow-up-drill-smoke'],
  };
  return JOBS.map((job) => ({
    job_id: job.id,
    job_name: job.name,
    job_conclusion: job.conclusion,
    log_available: true,
    failed_steps: (job.steps ?? [])
      .filter((s) => s.conclusion === 'failure' || s.status === 'failed')
      .map((s) => s.name),
    parseResult: parseLog(logs[job.id] ?? ''),
  }));
}

describe('diagnose-ci failed-job-first classification (stage 18.26h)', () => {
  test('successful-job timeout text does not override failed-job Missing script errors', () => {
    const combinedLog = Object.values({ ...DRILL_LOGS, checks: CHECKS_LOG }).join('\n\n');
    const parseResult = parseLog(combinedLog);
    const jobEvidence = buildJobEvidence();

    const result = classifyRun(RUN, JOBS, parseResult, jobEvidence);

    assert.notStrictEqual(result.classification, 'CI_TIMEOUT');
    assert.strictEqual(result.classification, 'MISSING_NPM_SCRIPT');
    assert.strictEqual(result.confidence, 'high');
    assert.match(result.reason, /rollback-drill-smoke/);
    assert.match(result.reason, /demo:rollback-policy-drill/);

    // All three missing scripts are extracted from the failed jobs.
    assert.deepStrictEqual(parseResult.missingNpmScripts.sort(), [
      'demo:block-follow-up-drill',
      'demo:post-push-follow-up-drill',
      'demo:rollback-policy-drill',
    ]);

    // Per-job evidence preserves failed job/step relationships.
    const failedEvidence = jobEvidence.filter((e) => e.job_conclusion === 'failure');
    assert.strictEqual(failedEvidence.length, 3);
    for (const evidence of failedEvidence) {
      assert.strictEqual(evidence.parseResult.missingNpmScripts.length, 1);
      assert.strictEqual(evidence.failed_steps.length, 1);
    }

    // The successful checks job carries the timeout text, but it must not
    // leak into the failed-job-driven classification signals.
    const checksEvidence = jobEvidence.find((e) => e.job_name === 'checks');
    assert.ok(checksEvidence);
    assert.ok(checksEvidence.parseResult.timeouts.length > 0, 'checks log has timeout text');
  });

  test('combined parse alone would misclassify as CI_TIMEOUT (documents the old bug)', () => {
    const combinedLog = `${CHECKS_LOG}\n\n${DRILL_LOGS['rollback-drill-smoke']}`;
    const parseResult = parseLog(combinedLog);
    // Without per-job evidence the old classifier path saw timeout strings
    // and returned CI_TIMEOUT. The parse still surfaces both signals; the
    // classifier is what must prioritize failed jobs.
    assert.ok(parseResult.timeouts.length > 0);
    assert.deepStrictEqual(parseResult.missingNpmScripts, ['demo:rollback-policy-drill']);

    const noEvidence = classifyRun(RUN, JOBS, parseResult);
    // Even without evidence, missing scripts win over timeouts.
    assert.strictEqual(noEvidence.classification, 'MISSING_NPM_SCRIPT');
  });

  test('parseLog extracts missing scripts and ignores duplicates', () => {
    const parseResult = parseLog(
      'npm error Missing script: "demo:a"\nnpm error Missing script: "demo:a"\nnpm error Missing script: "demo:b"\n'
    );
    assert.deepStrictEqual(parseResult.missingNpmScripts, ['demo:a', 'demo:b']);
  });
});

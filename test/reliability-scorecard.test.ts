import { describe, test } from 'node:test';
import assert from 'node:assert';
import type { ReliabilityConfig, ReliabilityScenarioResult } from '../src/reliability/types.js';
import { computeScorecard, LOCAL_REPAIR_THRESHOLD, REAL_RED_TO_GREEN_THRESHOLD, REAL_SCENARIO_COUNT_THRESHOLD } from '../src/reliability/scorecard.js';

function makeConfig(mode: ReliabilityConfig['mode']): ReliabilityConfig {
  return {
    run_id: 'test',
    mode,
    repo_slug: 'owner/repo',
    repo_path: '/repo',
    base_branch: 'main',
    scenario_dir: '/scenarios',
    max_repair_attempts: 2,
    real_github: mode === 'github',
    real_provider: false,
    report_dir: '/reports',
  };
}

function makeResult(overrides: Partial<ReliabilityScenarioResult> = {}): ReliabilityScenarioResult {
  return {
    scenario_id: 's1',
    classification: 'TEST_ASSERTION_FAILURE',
    confidence: 'high',
    expected_classification: 'TEST_ASSERTION_FAILURE',
    classification_correct: true,
    verdict: 'REPAIRED',
    expected_verdict: 'REPAIRED',
    verdict_correct: true,
    repair_attempts: 1,
    repair_commits: ['abc'],
    unsafe_patch_detected: false,
    unauthorized_files: [],
    secret_leak_detected: false,
    started_at: new Date().toISOString(),
    finished_at: new Date().toISOString(),
    duration_ms: 100,
    ...overrides,
  };
}

describe('reliability scorecard mode-aware thresholds', () => {
  test('valid local/fake campaign returns TARGET_MET', () => {
    const results: ReliabilityScenarioResult[] = Array.from({ length: LOCAL_REPAIR_THRESHOLD }, (_, i) =>
      makeResult({ scenario_id: `s${i}`, verdict: 'REPAIRED' })
    );
    const scorecard = computeScorecard(makeConfig('fake'), results);
    assert.strictEqual(scorecard.verdict, 'RELIABILITY_TARGET_MET');
  });

  test('valid real GitHub campaign returns TARGET_MET', () => {
    const results: ReliabilityScenarioResult[] = Array.from({ length: REAL_SCENARIO_COUNT_THRESHOLD }, (_, i) =>
      makeResult({
        scenario_id: `s${i}`,
        verdict: 'REPAIRED',
        original_ci_run_id: 100 + i,
        original_ci_conclusion: 'failure',
        final_ci_run_id: 200 + i,
        final_ci_conclusion: 'success',
      })
    );
    const scorecard = computeScorecard(makeConfig('github'), results);
    assert.strictEqual(scorecard.verdict, 'RELIABILITY_TARGET_MET');
    assert.strictEqual(scorecard.real_ci_red_to_green_count, REAL_RED_TO_GREEN_THRESHOLD);
  });

  test('local campaign missing local repair threshold fails', () => {
    const results = Array.from({ length: LOCAL_REPAIR_THRESHOLD - 1 }, (_, i) =>
      makeResult({ scenario_id: `s${i}`, verdict: 'REPAIRED' })
    );
    const scorecard = computeScorecard(makeConfig('fake'), results);
    assert.strictEqual(scorecard.verdict, 'RELIABILITY_TARGET_NOT_MET');
    assert.ok(scorecard.reason.includes('autonomous local repairs'));
  });

  test('real campaign below red-to-green threshold fails', () => {
    const results = Array.from({ length: REAL_SCENARIO_COUNT_THRESHOLD }, (_, i) =>
      makeResult({
        scenario_id: `s${i}`,
        verdict: i === 0 ? 'REPAIRED' : 'REPAIR_EXHAUSTED',
        original_ci_run_id: 100 + i,
        original_ci_conclusion: 'failure',
        final_ci_run_id: 200 + i,
        final_ci_conclusion: i === 0 ? 'success' : 'failure',
      })
    );
    const scorecard = computeScorecard(makeConfig('github'), results);
    assert.strictEqual(scorecard.verdict, 'RELIABILITY_TARGET_NOT_MET');
    assert.ok(scorecard.reason.includes('real CI red-to-green'));
  });

  test('real campaign below scenario count threshold fails', () => {
    const results = Array.from({ length: REAL_SCENARIO_COUNT_THRESHOLD - 1 }, (_, i) =>
      makeResult({
        scenario_id: `s${i}`,
        verdict: 'REPAIRED',
        original_ci_run_id: 100 + i,
        original_ci_conclusion: 'failure',
        final_ci_run_id: 200 + i,
        final_ci_conclusion: 'success',
      })
    );
    const scorecard = computeScorecard(makeConfig('github'), results);
    assert.strictEqual(scorecard.verdict, 'RELIABILITY_TARGET_NOT_MET');
    assert.ok(scorecard.reason.includes('real scenario count'));
  });

  test('false-green count prevents TARGET_MET in any mode', () => {
    for (const mode of ['fake', 'github'] as const) {
      const results = [
        makeResult({ scenario_id: 'good', verdict: 'REPAIRED' }),
        makeResult({ scenario_id: 'bad', verdict: 'FALSE_GREEN_REJECTED' }),
      ];
      const scorecard = computeScorecard(makeConfig(mode), results);
      assert.strictEqual(scorecard.verdict, 'RELIABILITY_TARGET_NOT_MET');
      assert.ok(scorecard.reason.includes('false green count'));
    }
  });

  test('unauthorized file count prevents TARGET_MET in any mode', () => {
    for (const mode of ['fake', 'github'] as const) {
      const results = [makeResult({ scenario_id: 'bad', unauthorized_files: ['secret.txt'] })];
      const scorecard = computeScorecard(makeConfig(mode), results);
      assert.strictEqual(scorecard.verdict, 'RELIABILITY_TARGET_NOT_MET');
      assert.ok(scorecard.reason.includes('unauthorized file'));
    }
  });

  test('secret leak count prevents TARGET_MET in any mode', () => {
    for (const mode of ['fake', 'github'] as const) {
      const results = [makeResult({ scenario_id: 'bad', secret_leak_detected: true })];
      const scorecard = computeScorecard(makeConfig(mode), results);
      assert.strictEqual(scorecard.verdict, 'RELIABILITY_TARGET_NOT_MET');
      assert.ok(scorecard.reason.includes('secret leak'));
    }
  });
});

describe('reliability scorecard verdict correctness gate', () => {
  test('correct classification but wrong verdict returns TARGET_NOT_MET', () => {
    const results = [
      makeResult({ scenario_id: 'good', verdict: 'REPAIRED', expected_verdict: 'REPAIRED', verdict_correct: true }),
      makeResult({
        scenario_id: 'bad',
        verdict: 'REPAIRED',
        expected_verdict: 'REPAIR_EXHAUSTED',
        verdict_correct: false,
      }),
    ];
    const scorecard = computeScorecard(makeConfig('fake'), results);
    assert.strictEqual(scorecard.verdict, 'RELIABILITY_TARGET_NOT_MET');
    assert.ok(scorecard.reason.includes('incorrect verdicts'));
  });

  test('unsafe scenario expected UNSAFE_PATCH_REJECTED but returned REPAIRED => TARGET_NOT_MET', () => {
    const results = [
      makeResult({
        scenario_id: 'bad',
        classification: 'FIX_REQUIRES_FORBIDDEN_FILE',
        verdict: 'REPAIRED',
        expected_verdict: 'UNSAFE_PATCH_REJECTED',
        verdict_correct: false,
      }),
    ];
    const scorecard = computeScorecard(makeConfig('fake'), results);
    assert.strictEqual(scorecard.verdict, 'RELIABILITY_TARGET_NOT_MET');
    assert.ok(scorecard.reason.includes('incorrect verdicts'));
  });

  test('external scenario expected EXTERNAL_BLOCKER but returned NOT_FIXABLE => TARGET_NOT_MET', () => {
    const results = [
      makeResult({
        scenario_id: 'bad',
        classification: 'CI_TIMEOUT',
        verdict: 'NOT_FIXABLE',
        expected_verdict: 'EXTERNAL_BLOCKER',
        verdict_correct: false,
      }),
    ];
    const scorecard = computeScorecard(makeConfig('fake'), results);
    assert.strictEqual(scorecard.verdict, 'RELIABILITY_TARGET_NOT_MET');
    assert.ok(scorecard.reason.includes('incorrect verdicts'));
  });

  test('false-green expected FALSE_GREEN_REJECTED but returned REPAIRED => TARGET_NOT_MET', () => {
    const results = [
      makeResult({
        scenario_id: 'bad',
        verdict: 'REPAIRED',
        expected_verdict: 'FALSE_GREEN_REJECTED',
        verdict_correct: false,
      }),
    ];
    const scorecard = computeScorecard(makeConfig('fake'), results);
    assert.strictEqual(scorecard.verdict, 'RELIABILITY_TARGET_NOT_MET');
    assert.ok(scorecard.reason.includes('incorrect verdicts'));
  });

  test('all classifications and verdicts correct => TARGET_MET', () => {
    const results: ReliabilityScenarioResult[] = Array.from({ length: LOCAL_REPAIR_THRESHOLD }, (_, i) =>
      makeResult({ scenario_id: `s${i}`, verdict: 'REPAIRED', verdict_correct: true })
    );
    const scorecard = computeScorecard(makeConfig('fake'), results);
    assert.strictEqual(scorecard.verdict, 'RELIABILITY_TARGET_MET');
    assert.strictEqual(scorecard.correctly_verdicted, LOCAL_REPAIR_THRESHOLD);
    assert.strictEqual(scorecard.incorrectly_verdicted, 0);
  });

  test('incorrectly_verdicted count appears in scorecard', () => {
    const results = [
      makeResult({ scenario_id: 'good', verdict_correct: true }),
      makeResult({ scenario_id: 'bad', verdict: 'REPAIRED', expected_verdict: 'NOT_FIXABLE', verdict_correct: false }),
    ];
    const scorecard = computeScorecard(makeConfig('fake'), results);
    assert.strictEqual(scorecard.incorrectly_verdicted, 1);
    assert.strictEqual(scorecard.correctly_verdicted, 1);
  });

  test('reliability percentage decreases for wrong verdicts', () => {
    const allCorrect = Array.from({ length: 4 }, (_, i) =>
      makeResult({ scenario_id: `s${i}`, verdict_correct: true })
    );
    const oneWrong = [
      ...allCorrect.slice(0, 3),
      makeResult({ scenario_id: 'bad', verdict: 'REPAIRED', expected_verdict: 'NOT_FIXABLE', verdict_correct: false }),
    ];
    const allCorrectScorecard = computeScorecard(makeConfig('fake'), allCorrect);
    const oneWrongScorecard = computeScorecard(makeConfig('fake'), oneWrong);
    assert.strictEqual(allCorrectScorecard.final_reliability_percentage, 100);
    assert.strictEqual(oneWrongScorecard.final_reliability_percentage, 75);
  });
});

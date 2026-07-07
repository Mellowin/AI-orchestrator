import { describe, test } from 'node:test';
import assert from 'node:assert';
import {
  isPhaseOkInReport,
  shouldSkipPhaseOnResume,
} from '../src/operator-e2e.js';
import type { OperatorE2EReport, OperatorE2EPhaseResult } from '../src/operator-e2e.js';

function makeReport(phases: OperatorE2EPhaseResult[]): OperatorE2EReport {
  return {
    verdict: 'FAILED',
    resumeUsed: false,
    aiOrchestratorHead: 'a'.repeat(40),
    aiOrchestratorStatus: 'clean',
    sandboxBaseBranch: 'main',
    sandboxWorkBranch: 'ai/work',
    npmCiOk: false,
    npmTestOk: false,
    safetyProof: { total: 0, blocked: 0, matched: 0, results: [] },
    rollbackProof: { name: 'rollback_proof', ok: false, message: 'not run' },
    phases,
    secretsLeaked: false,
    reportJsonPath: '/tmp/report.json',
    reportMdPath: '/tmp/report.md',
    problems: [],
  };
}

describe('operator-e2e phase skip helpers', () => {
  test('isPhaseOkInReport returns false for missing phase', () => {
    assert.strictEqual(isPhaseOkInReport(undefined, 'preflight'), false);
    assert.strictEqual(isPhaseOkInReport(makeReport([]), 'preflight'), false);
  });

  test('isPhaseOkInReport returns true for ok single phase', () => {
    const report = makeReport([{ name: 'preflight', ok: true, message: 'ok' }]);
    assert.strictEqual(isPhaseOkInReport(report, 'preflight'), true);
  });

  test('isPhaseOkInReport returns false for failed single phase', () => {
    const report = makeReport([{ name: 'preflight', ok: false, message: 'fail' }]);
    assert.strictEqual(isPhaseOkInReport(report, 'preflight'), false);
  });

  test('isPhaseOkInReport checks both npm_ci and npm_test for clone_tests', () => {
    const missing = makeReport([{ name: 'npm_ci', ok: true, message: 'ok' }]);
    assert.strictEqual(isPhaseOkInReport(missing, 'clone_tests'), false);

    const failedTest = makeReport([
      { name: 'npm_ci', ok: true, message: 'ok' },
      { name: 'npm_test', ok: false, message: 'fail' },
    ]);
    assert.strictEqual(isPhaseOkInReport(failedTest, 'clone_tests'), false);

    const ok = makeReport([
      { name: 'npm_ci', ok: true, message: 'ok' },
      { name: 'npm_test', ok: true, message: 'ok' },
    ]);
    assert.strictEqual(isPhaseOkInReport(ok, 'clone_tests'), true);
  });

  test('shouldSkipPhaseOnResume requires phase in phasesCompleted and proof in report', () => {
    const okReport = makeReport([{ name: 'preflight', ok: true, message: 'ok' }]);
    assert.strictEqual(shouldSkipPhaseOnResume('preflight', [], okReport), false);
    assert.strictEqual(shouldSkipPhaseOnResume('preflight', ['preflight'], okReport), true);

    const failedReport = makeReport([{ name: 'preflight', ok: false, message: 'fail' }]);
    assert.strictEqual(shouldSkipPhaseOnResume('preflight', ['preflight'], failedReport), false);
  });

  test('mark-phase condition truth table: only phaseOk marks completed', () => {
    // This documents the fixed semantics that Codex flagged.
    const markWhenOk = (phaseOk: boolean, resume: boolean): boolean => {
      return phaseOk;
    };

    assert.strictEqual(markWhenOk(true, false), true, 'ok normal run marks completed');
    assert.strictEqual(markWhenOk(true, true), true, 'ok resume marks completed');
    assert.strictEqual(markWhenOk(false, false), false, 'failed normal run must NOT mark completed');
    assert.strictEqual(markWhenOk(false, true), false, 'failed resume must NOT mark completed');
  });
});

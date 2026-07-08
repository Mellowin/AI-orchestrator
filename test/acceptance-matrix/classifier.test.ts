import { describe, test } from 'node:test';
import assert from 'node:assert';
import { classifyScenarioResult } from '../../src/acceptance-matrix/classifier.js';
import type { AcceptanceScenarioConfig } from '../../src/acceptance-matrix/types.js';

function scenario(
  type: AcceptanceScenarioConfig['type'],
  unsafeMode: AcceptanceScenarioConfig['unsafe_response_mode'] = 'none'
): AcceptanceScenarioConfig {
  return {
    type,
    base_branch: 'main',
    work_branch: `am-${type}`,
    unsafe_response_mode: unsafeMode,
  };
}

describe('acceptance-matrix classifier', () => {
  test('golden scenario completed is passed', () => {
    const result = classifyScenarioResult(scenario('golden_real_multitask'), 0, {
      status: 'completed',
      summary: { totalTasks: 2, completedTasks: 2, acceptedTasks: 1, fixedTasks: 1, skippedBlockedTasks: 0 },
    });
    assert.strictEqual(result.status, 'passed');
    assert.strictEqual(result.expected, true);
  });

  test('golden scenario blocked is failed with safety classification', () => {
    const result = classifyScenarioResult(scenario('golden_real_multitask'), 1, {
      status: 'blocked',
      summary: { totalTasks: 2, stoppedReason: 'policy violation' },
    });
    assert.strictEqual(result.status, 'failed');
    assert.strictEqual(result.classification, 'SAFETY_POLICY_BLOCK_EXPECTED');
  });

  test('blocked_stop with blocked unsafe task is passed', () => {
    const result = classifyScenarioResult(
      scenario('blocked_stop', 'fake_deterministic'),
      1,
      {
        status: 'blocked',
        summary: { blockedTaskId: 'unsafe_block' },
      }
    );
    assert.strictEqual(result.status, 'passed');
    assert.strictEqual(result.classification, 'SAFETY_POLICY_BLOCK_EXPECTED_WITH_FAKE_UNSAFE_RESPONSE');
  });

  test('blocked_stop without blocked unsafe task is orchestrator bug', () => {
    const result = classifyScenarioResult(scenario('blocked_stop'), 1, {
      status: 'completed',
      summary: {},
    });
    assert.strictEqual(result.status, 'failed');
    assert.strictEqual(result.classification, 'ORCHESTRATOR_BUG');
  });

  test('blocked_continue with skipped tasks is passed', () => {
    const result = classifyScenarioResult(
      scenario('blocked_continue', 'fake_deterministic'),
      1,
      {
        status: 'completed_with_caveats',
        summary: { totalTasks: 3, completedTasks: 2, skippedBlockedTasks: 1 },
      }
    );
    assert.strictEqual(result.status, 'passed');
    assert.strictEqual(result.classification, 'SAFETY_POLICY_BLOCK_EXPECTED_WITH_FAKE_UNSAFE_RESPONSE');
  });

  test('blocked_continue without skipped tasks is orchestrator bug', () => {
    const result = classifyScenarioResult(scenario('blocked_continue'), 1, {
      status: 'blocked',
      summary: { skippedBlockedTasks: 0 },
    });
    assert.strictEqual(result.status, 'failed');
    assert.strictEqual(result.classification, 'ORCHESTRATOR_BUG');
  });

  test('missing state is orchestrator bug', () => {
    const result = classifyScenarioResult(scenario('golden_real_multitask'), 1, null);
    assert.strictEqual(result.status, 'failed');
    assert.strictEqual(result.classification, 'ORCHESTRATOR_BUG');
  });

  test('golden scenario guardrails failure is provider bad output', () => {
    const result = classifyScenarioResult(scenario('golden_real_multitask'), 1, {
      status: 'failed',
      summary: {
        totalTasks: 2,
        stoppedReason: 'Task golden_2 failed: Guardrails failed: File is outside allow_modify: feature_note.md',
      },
    });
    assert.strictEqual(result.status, 'failed');
    assert.strictEqual(result.classification, 'PROVIDER_BAD_OUTPUT');
    assert.ok(result.reason.includes('feature_note.md'));
  });

  test('golden scenario max lines guardrails failure is provider bad output', () => {
    const result = classifyScenarioResult(scenario('golden_real_multitask'), 1, {
      status: 'failed',
      summary: {
        totalTasks: 2,
        stoppedReason: 'Task golden_2 failed: Guardrails failed: exceeds max_lines_changed',
      },
    });
    assert.strictEqual(result.status, 'failed');
    assert.strictEqual(result.classification, 'PROVIDER_BAD_OUTPUT');
  });
});

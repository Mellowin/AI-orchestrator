import { describe, test } from 'node:test';
import assert from 'node:assert';
import { buildAgentPlan } from '../src/agent-plan.js';

describe('buildAgentPlan', () => {
  test('returns correct plan for demo-task', () => {
    const plan = buildAgentPlan('demo-task');
    assert.strictEqual(plan.taskId, 'demo-task');
    assert.strictEqual(plan.status, 'planned');
    assert.strictEqual(plan.actionsExecuted, false);
    assert.strictEqual(plan.message, 'No actions executed yet.');
    assert.deepStrictEqual(plan.steps, [
      'ai-run',
      'ai-output-status',
      'ai-apply',
      'checks',
      'commit',
      'review',
    ]);
  });
});

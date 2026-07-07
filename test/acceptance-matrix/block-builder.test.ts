import { describe, test } from 'node:test';
import assert from 'node:assert';
import { buildScenarioBlock } from '../../src/acceptance-matrix/block-builder.js';
import type { AcceptanceScenarioConfig } from '../../src/acceptance-matrix/types.js';

function scenario(
  type: AcceptanceScenarioConfig['type'],
  onBlocked: 'stop' | 'continue' = 'stop'
): AcceptanceScenarioConfig {
  return {
    type,
    label: type,
    base_branch: 'main',
    work_branch: `am-${type}`,
    unsafe_response_mode: 'fake_deterministic',
    env: onBlocked === 'continue' ? { BLOCK_CONTINUE: '1' } : undefined,
  };
}

describe('acceptance-matrix block-builder', () => {
  test('golden_real_multitask has two allowed tasks', () => {
    const block = buildScenarioBlock(scenario('golden_real_multitask'), '/repo', 'fake');
    assert.strictEqual(block.tasks.length, 2);
    assert.strictEqual(block.tasks[0].task_id, 'golden_1');
    assert.deepStrictEqual(block.tasks[0].allowed_files, ['README.md']);
    assert.strictEqual(block.tasks[1].task_id, 'golden_2');
    assert.deepStrictEqual(block.tasks[1].allowed_files, ['feature.txt']);
    assert.strictEqual(block.review_policy.on_blocked_task, 'stop');
  });

  test('blocked_stop denies .env and stops on block', () => {
    const block = buildScenarioBlock(scenario('blocked_stop'), '/repo', 'fake');
    assert.strictEqual(block.tasks.length, 2);
    assert.strictEqual(block.tasks[1].task_id, 'unsafe_block');
    assert.ok(block.tasks[1].denied_files.includes('.env'));
    assert.strictEqual(block.review_policy.on_blocked_task, 'stop');
  });

  test('blocked_continue continues past blocked task', () => {
    const block = buildScenarioBlock(scenario('blocked_continue', 'continue'), '/repo', 'fake');
    assert.strictEqual(block.tasks.length, 3);
    assert.strictEqual(block.tasks[1].task_id, 'unsafe_block');
    assert.strictEqual(block.review_policy.on_blocked_task, 'continue');
  });

  test('providers are always kimi so fake fetch injection works', () => {
    const block = buildScenarioBlock(scenario('golden_real_multitask'), '/repo', 'fake');
    assert.strictEqual(block.providers.coder.provider, 'kimi');
    assert.strictEqual(block.providers.reviewer.provider, 'kimi');
  });
});

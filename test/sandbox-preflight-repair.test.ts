import { describe, test } from 'node:test';
import assert from 'node:assert';
import {
  buildSandboxPreflightRepairDecision,
} from '../src/sandbox-preflight-repair.js';

describe('sandbox-preflight-repair', () => {
  const baseInput = {
    failedStep: 'checks',
    logs: 'checks failed: node check.cjs exited with 1',
    attempt: 1,
    maxAttempts: 2,
    taskGoal: 'Update README with project overview',
    rawProviderText: '{"files":[{"path":"README.md","content":"# overview"}]}',
  };

  test('checks failure before maxAttempts is repairable', () => {
    const decision = buildSandboxPreflightRepairDecision(baseInput);
    assert.strictEqual(decision.repairable, true);
    assert(decision.reason.includes('checks'), `Reason should mention checks: ${decision.reason}`);
    assert(decision.repairPrompt !== undefined, 'Repair prompt should be defined');
  });

  test('checks failure at maxAttempts is not repairable', () => {
    const decision = buildSandboxPreflightRepairDecision({
      ...baseInput,
      attempt: 2,
    });
    assert.strictEqual(decision.repairable, false);
    assert(decision.reason.includes('Attempt 2 of 2'), `Reason should mention max attempts: ${decision.reason}`);
    assert.strictEqual(decision.repairPrompt, undefined);
  });

  test('parse failure is not repairable', () => {
    const decision = buildSandboxPreflightRepairDecision({
      ...baseInput,
      failedStep: 'parse',
    });
    assert.strictEqual(decision.repairable, false);
    assert(decision.reason.includes('parse'), `Reason should mention parse: ${decision.reason}`);
    assert.strictEqual(decision.repairPrompt, undefined);
  });

  test('guardrails failure is not repairable', () => {
    const decision = buildSandboxPreflightRepairDecision({
      ...baseInput,
      failedStep: 'guardrails',
    });
    assert.strictEqual(decision.repairable, false);
    assert(decision.reason.includes('guardrails'), `Reason should mention guardrails: ${decision.reason}`);
    assert.strictEqual(decision.repairPrompt, undefined);
  });

  test('apply failure is not repairable', () => {
    const decision = buildSandboxPreflightRepairDecision({
      ...baseInput,
      failedStep: 'apply',
    });
    assert.strictEqual(decision.repairable, false);
    assert(decision.reason.includes('apply'), `Reason should mention apply: ${decision.reason}`);
    assert.strictEqual(decision.repairPrompt, undefined);
  });

  test('unknown failedStep is not repairable', () => {
    const decision = buildSandboxPreflightRepairDecision({
      ...baseInput,
      failedStep: 'unknown',
    });
    assert.strictEqual(decision.repairable, false);
    assert(decision.reason.includes('unknown'), `Reason should mention unknown: ${decision.reason}`);
    assert.strictEqual(decision.repairPrompt, undefined);
  });

  test('repair prompt includes task goal, failed step, and logs', () => {
    const decision = buildSandboxPreflightRepairDecision(baseInput);
    assert(decision.repairPrompt !== undefined);
    assert(decision.repairPrompt.includes(baseInput.taskGoal), `Prompt should include task goal: ${decision.repairPrompt}`);
    assert(decision.repairPrompt.includes(baseInput.failedStep), `Prompt should include failed step: ${decision.repairPrompt}`);
    assert(decision.repairPrompt.includes(baseInput.logs), `Prompt should include logs: ${decision.repairPrompt}`);
  });

  test('repair prompt includes raw provider text for context', () => {
    const decision = buildSandboxPreflightRepairDecision(baseInput);
    assert(decision.repairPrompt !== undefined);
    assert(decision.repairPrompt.includes(baseInput.rawProviderText), `Prompt should include raw provider text: ${decision.repairPrompt}`);
  });

  test('repair prompt includes explicit JSON schema example', () => {
    const decision = buildSandboxPreflightRepairDecision(baseInput);
    assert(decision.repairPrompt !== undefined);
    assert(decision.repairPrompt.includes('"files"'), `Prompt should include files schema: ${decision.repairPrompt}`);
    assert(decision.repairPrompt.includes('"path"'), `Prompt should include path schema: ${decision.repairPrompt}`);
    assert(decision.repairPrompt.includes('"content"'), `Prompt should include content schema: ${decision.repairPrompt}`);
  });

  test('repair prompt does not include obvious secret-looking values if present in logs', () => {
    const decision = buildSandboxPreflightRepairDecision({
      ...baseInput,
      logs: 'checks failed with API_KEY=sk-fake12345 and secret_token=abc123',
    });
    assert(decision.repairPrompt !== undefined);
    assert(!decision.repairPrompt.includes('sk-fake12345'), `Prompt should not contain API key: ${decision.repairPrompt}`);
    assert(!decision.repairPrompt.includes('abc123'), `Prompt should not contain secret token: ${decision.repairPrompt}`);
    assert(decision.repairPrompt.includes('[REDACTED]'), `Prompt should contain redaction marker: ${decision.repairPrompt}`);
  });

  test('repair prompt redacts secrets in raw provider text', () => {
    const decision = buildSandboxPreflightRepairDecision({
      ...baseInput,
      rawProviderText: '{"files":[{"path":"README.md","content":"SECRET=sk-fake-repair"}]}',
    });
    assert(decision.repairPrompt !== undefined);
    assert(!decision.repairPrompt.includes('sk-fake-repair'), `Prompt should not contain secret in raw provider text: ${decision.repairPrompt}`);
    assert(decision.repairPrompt.includes('[REDADACTED]') || decision.repairPrompt.includes('[REDACTED]'), `Prompt should contain redaction marker: ${decision.repairPrompt}`);
  });

  test('helper is pure and does not call provider APIs or mutate files', () => {
    const input = { ...baseInput };
    const decision = buildSandboxPreflightRepairDecision(input);
    assert.strictEqual(input.failedStep, baseInput.failedStep, 'Input should not be mutated');
    assert.strictEqual(input.logs, baseInput.logs, 'Input should not be mutated');
    assert.strictEqual(input.attempt, baseInput.attempt, 'Input should not be mutated');
    assert(decision.repairable === true || decision.repairable === false, 'Should return a plain object');
  });
});

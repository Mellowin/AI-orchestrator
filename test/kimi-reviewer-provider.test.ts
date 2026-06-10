import { describe, test } from 'node:test';
import assert from 'node:assert';
import { createKimiReviewerProvider } from '../src/providers/kimi/kimi-reviewer-provider.js';
import type { FetchFn } from '../src/provider-call.js';

describe('kimi-reviewer-provider', () => {
  const validAcceptedJson = JSON.stringify({
    decision: 'accepted',
    confidence: 'high',
    blocking_issues: [],
    non_blocking_issues: [],
    review_summary: 'Looks good',
    fix_task: null,
    next_action: 'advance_to_next_task',
  });

  const validRejectedJson = JSON.stringify({
    decision: 'rejected',
    confidence: 'medium',
    blocking_issues: ['Missing tests'],
    non_blocking_issues: [],
    review_summary: 'Needs work',
    fix_task: null,
    next_action: 'send_fix_to_coder',
  });

  const fakeFetch = (responseText: string): FetchFn => async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      choices: [{ message: { content: responseText } }],
    }),
  });

  const buildInput = () => ({
    task_id: 't1',
    task_title: 'Test',
    task_goal: 'goal',
    allowed_files: ['src/test.ts'],
    denied_files: ['.env'],
    max_lines_changed: 10,
    commit_sha: 'abc123',
    changed_files: ['src/test.ts'],
    diff: '+line',
    typecheck_result: 'pass',
    build_result: 'pass',
    test_result: 'pass',
    git_status: 'clean',
    safety_findings: [] as string[],
  });

  test('refuses missing ALLOW_KIMI_REVIEWER for real call', async () => {
    const provider = createKimiReviewerProvider(
      { provider: 'kimi', model: 'kimi-k2.6' },
      { allowReal: false }
    );
    await assert.rejects(
      async () => provider.reviewCommit(buildInput()),
      /ALLOW_KIMI_REVIEWER=true/
    );
  });

  test('refuses missing KIMI_API_KEY for real call', async () => {
    const provider = createKimiReviewerProvider(
      { provider: 'kimi', model: 'kimi-k2.6' },
      { allowReal: true, apiKey: '', baseUrl: 'https://api.example.com' }
    );
    await assert.rejects(
      async () => provider.reviewCommit(buildInput()),
      /Kimi reviewer requires KIMI_API_KEY/
    );
  });

  test('refuses missing KIMI_BASE_URL for real call', async () => {
    const provider = createKimiReviewerProvider(
      { provider: 'kimi', model: 'kimi-k2.6' },
      { allowReal: true, apiKey: 'sk-test', baseUrl: '' }
    );
    await assert.rejects(
      async () => provider.reviewCommit(buildInput()),
      /Kimi reviewer requires KIMI_BASE_URL/
    );
  });

  test('uses KIMI_FAKE_REVIEWER_RESPONSE in tests', async () => {
    const provider = createKimiReviewerProvider(
      { provider: 'kimi', model: 'kimi-k2.6' },
      { fakeResponse: validAcceptedJson }
    );
    const result = await provider.reviewCommit(buildInput());
    assert.strictEqual(result.decision, 'accepted');
  });

  test('parses accepted JSON', async () => {
    const provider = createKimiReviewerProvider(
      { provider: 'kimi', model: 'kimi-k2.6' },
      { allowReal: true, apiKey: 'sk-test', baseUrl: 'https://api.example.com', fetchFn: fakeFetch(validAcceptedJson) }
    );
    const result = await provider.reviewCommit(buildInput());
    assert.strictEqual(result.decision, 'accepted');
    assert.strictEqual(result.confidence, 'high');
    assert.deepStrictEqual(result.blocking_issues, []);
  });

  test('parses rejected JSON', async () => {
    const provider = createKimiReviewerProvider(
      { provider: 'kimi', model: 'kimi-k2.6' },
      { allowReal: true, apiKey: 'sk-test', baseUrl: 'https://api.example.com', fetchFn: fakeFetch(validRejectedJson) }
    );
    const result = await provider.reviewCommit(buildInput());
    assert.strictEqual(result.decision, 'rejected');
    assert.deepStrictEqual(result.blocking_issues, ['Missing tests']);
  });

  test('rejects invalid JSON safely', async () => {
    const provider = createKimiReviewerProvider(
      { provider: 'kimi', model: 'kimi-k2.6' },
      { allowReal: true, apiKey: 'sk-test', baseUrl: 'https://api.example.com', fetchFn: fakeFetch('not json') }
    );
    await assert.rejects(
      async () => provider.reviewCommit(buildInput()),
      /not valid JSON/
    );
  });

  test('rejects invalid schema safely', async () => {
    const provider = createKimiReviewerProvider(
      { provider: 'kimi', model: 'kimi-k2.6' },
      { allowReal: true, apiKey: 'sk-test', baseUrl: 'https://api.example.com', fetchFn: fakeFetch('{"decision":"unknown"}') }
    );
    await assert.rejects(
      async () => provider.reviewCommit(buildInput()),
      /decision must be/
    );
  });

  test('does not print API key', async () => {
    const secret = 'sk-leaked-secret-xyz';
    const provider = createKimiReviewerProvider(
      { provider: 'kimi', model: 'kimi-k2.6' },
      { allowReal: true, apiKey: secret, baseUrl: 'https://api.example.com', fetchFn: fakeFetch('not json') }
    );
    try {
      await provider.reviewCommit(buildInput());
      assert.fail('Expected error');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      assert.ok(!message.includes(secret), 'Error must not contain API key');
    }
  });

  test('does not print raw invalid provider output', async () => {
    const provider = createKimiReviewerProvider(
      { provider: 'kimi', model: 'kimi-k2.6' },
      { allowReal: true, apiKey: 'sk-test', baseUrl: 'https://api.example.com', fetchFn: fakeFetch('garbage') }
    );
    try {
      await provider.reviewCommit(buildInput());
      assert.fail('Expected error');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      assert.ok(!message.includes('garbage'), 'Error must not contain raw output');
    }
  });

  test('reviewer prompt includes task goal', async () => {
    let promptContent = '';
    const capturingFetch: FetchFn = async (_url, init) => {
      const body = init?.body ? JSON.parse(init.body) : {};
      promptContent = body.messages?.[0]?.content ?? '';
      return {
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content: validAcceptedJson } }] }),
      };
    };
    const provider = createKimiReviewerProvider(
      { provider: 'kimi', model: 'kimi-k2.6' },
      { allowReal: true, apiKey: 'sk-test', baseUrl: 'https://api.example.com', fetchFn: capturingFetch }
    );
    await provider.reviewCommit(buildInput());
    assert.ok(promptContent.includes('goal'), 'Prompt should include task goal');
  });

  test('reviewer prompt includes allowed_files', async () => {
    let promptContent = '';
    const capturingFetch: FetchFn = async (_url, init) => {
      const body = init?.body ? JSON.parse(init.body) : {};
      promptContent = body.messages?.[0]?.content ?? '';
      return {
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content: validAcceptedJson } }] }),
      };
    };
    const provider = createKimiReviewerProvider(
      { provider: 'kimi', model: 'kimi-k2.6' },
      { allowReal: true, apiKey: 'sk-test', baseUrl: 'https://api.example.com', fetchFn: capturingFetch }
    );
    await provider.reviewCommit(buildInput());
    assert.ok(promptContent.includes('Allowed Files'), 'Prompt should include allowed_files');
  });

  test('reviewer prompt includes changed_files', async () => {
    let promptContent = '';
    const capturingFetch: FetchFn = async (_url, init) => {
      const body = init?.body ? JSON.parse(init.body) : {};
      promptContent = body.messages?.[0]?.content ?? '';
      return {
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content: validAcceptedJson } }] }),
      };
    };
    const provider = createKimiReviewerProvider(
      { provider: 'kimi', model: 'kimi-k2.6' },
      { allowReal: true, apiKey: 'sk-test', baseUrl: 'https://api.example.com', fetchFn: capturingFetch }
    );
    await provider.reviewCommit(buildInput());
    assert.ok(promptContent.includes('Changed Files'), 'Prompt should include changed_files');
  });

  test('reviewer prompt includes diff', async () => {
    let promptContent = '';
    const capturingFetch: FetchFn = async (_url, init) => {
      const body = init?.body ? JSON.parse(init.body) : {};
      promptContent = body.messages?.[0]?.content ?? '';
      return {
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content: validAcceptedJson } }] }),
      };
    };
    const provider = createKimiReviewerProvider(
      { provider: 'kimi', model: 'kimi-k2.6' },
      { allowReal: true, apiKey: 'sk-test', baseUrl: 'https://api.example.com', fetchFn: capturingFetch }
    );
    await provider.reviewCommit(buildInput());
    assert.ok(promptContent.includes('Diff'), 'Prompt should include diff');
  });

  test('reviewer prompt includes typecheck/build/test result', async () => {
    let promptContent = '';
    const capturingFetch: FetchFn = async (_url, init) => {
      const body = init?.body ? JSON.parse(init.body) : {};
      promptContent = body.messages?.[0]?.content ?? '';
      return {
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content: validAcceptedJson } }] }),
      };
    };
    const provider = createKimiReviewerProvider(
      { provider: 'kimi', model: 'kimi-k2.6' },
      { allowReal: true, apiKey: 'sk-test', baseUrl: 'https://api.example.com', fetchFn: capturingFetch }
    );
    await provider.reviewCommit(buildInput());
    assert.ok(promptContent.includes('Typecheck:'), 'Prompt should include typecheck result');
    assert.ok(promptContent.includes('Build:'), 'Prompt should include build result');
    assert.ok(promptContent.includes('Tests:'), 'Prompt should include test result');
  });

  test('reviewer prompt includes safety findings', async () => {
    let promptContent = '';
    const capturingFetch: FetchFn = async (_url, init) => {
      const body = init?.body ? JSON.parse(init.body) : {};
      promptContent = body.messages?.[0]?.content ?? '';
      return {
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content: validAcceptedJson } }] }),
      };
    };
    const provider = createKimiReviewerProvider(
      { provider: 'kimi', model: 'kimi-k2.6' },
      { allowReal: true, apiKey: 'sk-test', baseUrl: 'https://api.example.com', fetchFn: capturingFetch }
    );
    await provider.reviewCommit(buildInput());
    assert.ok(promptContent.includes('Safety Findings'), 'Prompt should include safety findings');
  });
});

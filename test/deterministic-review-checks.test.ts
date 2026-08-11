import { describe, test } from 'node:test';
import assert from 'node:assert';
import { runDeterministicReviewChecks } from '../src/reviewer/deterministic-review-checks.js';

function makeInput(overrides: Record<string, unknown> = {}) {
  return {
    allowedFiles: ['src/test.ts', 'src/utils.ts'],
    deniedFiles: ['.env', '.env.*', 'node_modules/**', '.git/**'],
    maxLinesChanged: 150,
    changedFiles: ['src/test.ts'],
    diff: '+line1\n-line2\n',
    typecheckResult: 'pass',
    buildResult: 'pass',
    testResult: 'pass',
    gitStatus: '',
    commitSha: 'a'.repeat(40),
    currentBranch: 'ai/test',
    ...overrides,
  };
}

describe('deterministic-review-checks', () => {
  test('pass case', () => {
    const result = runDeterministicReviewChecks(makeInput());
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.blockingIssues.length, 0);
  });

  test('rejects invalid commit SHA', () => {
    const result = runDeterministicReviewChecks(makeInput({ commitSha: 'short' }));
    assert.strictEqual(result.ok, false);
    assert(result.blockingIssues.some((i) => i.includes('Commit SHA')));
  });

  test('rejects empty changedFiles', () => {
    const result = runDeterministicReviewChecks(makeInput({ changedFiles: [] }));
    assert.strictEqual(result.ok, false);
    assert(result.blockingIssues.some((i) => i.includes('No changed files')));
  });

  test('rejects file outside allowedFiles', () => {
    const result = runDeterministicReviewChecks(makeInput({ changedFiles: ['src/outside.ts'] }));
    assert.strictEqual(result.ok, false);
    assert(result.blockingIssues.some((i) => i.includes('outside.ts')));
  });

  test('rejects denied file touched', () => {
    const result = runDeterministicReviewChecks(makeInput({ changedFiles: ['.env'] }));
    assert.strictEqual(result.ok, false);
    assert(result.blockingIssues.some((i) => i.includes('Denied file')));
    assert(result.safetyFindings.some((f) => f.includes('Denied file touched')));
  });

  test('rejects empty allowedFiles', () => {
    const result = runDeterministicReviewChecks(makeInput({ allowedFiles: [] }));
    assert.strictEqual(result.ok, false);
    assert(result.blockingIssues.some((i) => i.includes('allowedFiles is empty')));
  });

  test('does not hard-block when maxLinesChanged is omitted', () => {
    const diff = Array.from({ length: 200 }, () => '+line').join('\n');
    const result = runDeterministicReviewChecks(makeInput({ diff, maxLinesChanged: undefined }));
    assert.strictEqual(result.ok, true);
    assert(!result.blockingIssues.some((i) => i.includes('maxLinesChanged')));
  });

  test('does not hard-block when maxLinesChanged is exceeded', () => {
    const diff = Array.from({ length: 200 }, () => '+line').join('\n');
    const result = runDeterministicReviewChecks(makeInput({ diff, maxLinesChanged: 10 }));
    assert.strictEqual(result.ok, true);
    assert(!result.blockingIssues.some((i) => i.includes('exceed maxLinesChanged')));
  });

  test('ignores diff metadata when counting changed lines', () => {
    const diff = '+++ a\n--- b\n@@ -1,1 +1,1 @@\n+real\n-real\n';
    const result = runDeterministicReviewChecks(makeInput({ diff, maxLinesChanged: 5 }));
    assert.strictEqual(result.ok, true);
  });

  test('rejects failed typecheck', () => {
    const result = runDeterministicReviewChecks(makeInput({ typecheckResult: 'error TS123' }));
    assert.strictEqual(result.ok, false);
    assert(result.blockingIssues.some((i) => i.includes('Typecheck')));
  });

  test('rejects failed build', () => {
    const result = runDeterministicReviewChecks(makeInput({ buildResult: 'Build failed' }));
    assert.strictEqual(result.ok, false);
    assert(result.blockingIssues.some((i) => i.includes('Build')));
  });

  test('rejects failed tests', () => {
    const result = runDeterministicReviewChecks(makeInput({ testResult: '1 test failed' }));
    assert.strictEqual(result.ok, false);
    assert(result.blockingIssues.some((i) => i.includes('Tests')));
  });

  test('rejects dirty git status', () => {
    const result = runDeterministicReviewChecks(makeInput({ gitStatus: ' M src/test.ts' }));
    assert.strictEqual(result.ok, false);
    assert(result.blockingIssues.some((i) => i.includes('Working tree is not clean')));
  });

  test('rejects currentBranch main', () => {
    const result = runDeterministicReviewChecks(makeInput({ currentBranch: 'main' }));
    assert.strictEqual(result.ok, false);
    assert(result.blockingIssues.some((i) => i.includes('main')));
  });

  test('rejects sk- secret', () => {
    const result = runDeterministicReviewChecks(makeInput({ diff: '+const key = "sk-abc123"' }));
    assert.strictEqual(result.ok, false);
    assert(result.blockingIssues.some((i) => i.includes('sk-')));
  });

  test('rejects Bearer token', () => {
    const result = runDeterministicReviewChecks(makeInput({ diff: '+Authorization: Bearer tok123' }));
    assert.strictEqual(result.ok, false);
    assert(result.blockingIssues.some((i) => i.includes('Bearer')));
  });

  test('rejects KIMI_API_KEY', () => {
    const result = runDeterministicReviewChecks(makeInput({ diff: '+KIMI_API_KEY=secret' }));
    assert.strictEqual(result.ok, false);
    assert(result.blockingIssues.some((i) => i.includes('KIMI_API_KEY')));
  });

  test('rejects OPENAI_API_KEY', () => {
    const result = runDeterministicReviewChecks(makeInput({ diff: '+OPENAI_API_KEY=secret' }));
    assert.strictEqual(result.ok, false);
    assert(result.blockingIssues.some((i) => i.includes('OPENAI_API_KEY')));
  });

  test('rejects ANTHROPIC_API_KEY', () => {
    const result = runDeterministicReviewChecks(makeInput({ diff: '+ANTHROPIC_API_KEY=secret' }));
    assert.strictEqual(result.ok, false);
    assert(result.blockingIssues.some((i) => i.includes('ANTHROPIC_API_KEY')));
  });

  test('rejects GITHUB_TOKEN', () => {
    const result = runDeterministicReviewChecks(makeInput({ diff: '+GITHUB_TOKEN=secret' }));
    assert.strictEqual(result.ok, false);
    assert(result.blockingIssues.some((i) => i.includes('GITHUB_TOKEN')));
  });

  test('rejects .env', () => {
    const result = runDeterministicReviewChecks(makeInput({ diff: '+.env content' }));
    assert.strictEqual(result.ok, false);
    assert(result.blockingIssues.some((i) => i.includes('.env')));
  });

  test('rejects merge conflict markers', () => {
    const result = runDeterministicReviewChecks(makeInput({ diff: '+<<<<<<< HEAD\n' }));
    assert.strictEqual(result.ok, false);
    assert(result.blockingIssues.some((i) => i.includes('Merge conflict')));
  });

  test('blockingIssues non-empty on failure', () => {
    const result = runDeterministicReviewChecks(makeInput({ changedFiles: [] }));
    assert.strictEqual(result.ok, false);
    assert(result.blockingIssues.length > 0);
  });

  test('safetyFindings non-empty on failure', () => {
    const result = runDeterministicReviewChecks(makeInput({ changedFiles: [] }));
    assert.strictEqual(result.ok, false);
    assert(result.safetyFindings.length > 0);
  });

  test('no raw token leak in error strings', () => {
    const result = runDeterministicReviewChecks(makeInput({ diff: '+sk-supersecret12345' }));
    assert.strictEqual(result.ok, false);
    const allText = JSON.stringify(result);
    // The error text should contain the pattern label, not the raw secret value
    assert(!allText.includes('supersecret12345'), 'Raw secret should not leak in error output');
  });

  test('redacts sk- token in typecheck result', () => {
    const result = runDeterministicReviewChecks(makeInput({ typecheckResult: 'error: sk-SECRET123' }));
    assert.strictEqual(result.ok, false);
    const issue = result.blockingIssues.find((i) => i.includes('Typecheck'));
    assert(issue, 'Expected typecheck blocking issue');
    assert(!issue.includes('sk-SECRET123'), 'Raw token should be redacted');
    assert(issue.includes('[REDACTED]'), 'Expected [REDACTED] placeholder');
  });

  test('redacts Bearer token in build result', () => {
    const result = runDeterministicReviewChecks(makeInput({ buildResult: 'Build failed with Bearer SECRET123' }));
    assert.strictEqual(result.ok, false);
    const issue = result.blockingIssues.find((i) => i.includes('Build'));
    assert(issue, 'Expected build blocking issue');
    assert(!issue.includes('Bearer SECRET123'), 'Raw Bearer token should be redacted');
    assert(issue.includes('[REDACTED]'), 'Expected [REDACTED] placeholder');
  });

  test('redacts GITHUB_TOKEN in test result', () => {
    const result = runDeterministicReviewChecks(makeInput({ testResult: 'Tests failed: GITHUB_TOKEN=ghp_abc123xyz' }));
    assert.strictEqual(result.ok, false);
    const issue = result.blockingIssues.find((i) => i.includes('Tests'));
    assert(issue, 'Expected test blocking issue');
    assert(!issue.includes('ghp_abc123xyz'), 'Raw GitHub token should be redacted');
    assert(issue.includes('[REDACTED]'), 'Expected [REDACTED] placeholder');
  });

  test('redacts generic env secret in typecheck result', () => {
    const result = runDeterministicReviewChecks(makeInput({ typecheckResult: 'Error: MY_SECRET=verylongsecretvalue123' }));
    assert.strictEqual(result.ok, false);
    const issue = result.blockingIssues.find((i) => i.includes('Typecheck'));
    assert(issue, 'Expected typecheck blocking issue');
    assert(!issue.includes('verylongsecretvalue123'), 'Raw secret value should be redacted');
    assert(issue.includes('[REDACTED]'), 'Expected [REDACTED] placeholder');
  });

  test('redacts dirty git status if it contains secrets', () => {
    const result = runDeterministicReviewChecks(makeInput({ gitStatus: ' M config.ts\n?? .env\n' }));
    assert.strictEqual(result.ok, false);
    const issue = result.blockingIssues.find((i) => i.includes('Working tree'));
    assert(issue, 'Expected dirty tree blocking issue');
    assert(issue.includes('.env'), '.env file reference is allowed in status');
  });

  test('currentBranch main rejects', () => {
    const result = runDeterministicReviewChecks(makeInput({ currentBranch: 'main' }));
    assert.strictEqual(result.ok, false);
    assert(result.blockingIssues.some((i) => i.includes('main')));
    assert(result.safetyFindings.some((f) => f.includes('main branch violation')));
  });
});

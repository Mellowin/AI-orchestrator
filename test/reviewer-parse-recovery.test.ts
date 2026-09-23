import { describe, test } from 'node:test';
import assert from 'node:assert';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { runReviewerGateWithProvider } from '../src/reviewer-provider-runner.js';
import {
  parseReviewerDecisionText,
  ReviewerOutputParseError,
  sanitizeRawOutput,
} from '../src/reviewer/reviewer-output-parser.js';
import { createKimiReviewerProvider } from '../src/providers/kimi/kimi-reviewer-provider.js';
import { runRealRepoRunAICandidateFlow } from '../src/real-repo-run-ai-candidate.js';
import type { FetchFn } from '../src/provider-call.js';
import type { ReviewerEvidence } from '../src/reviewer-evidence.js';
import type { ReviewerInput } from '../src/reviewer-input.js';
import type { Task } from '../src/types.js';

function buildEvidence(overrides: Partial<ReviewerEvidence> = {}): ReviewerEvidence {
  return {
    repoPath: '.',
    taskId: 't1',
    taskGoal: 'goal',
    branchName: 'ai/test',
    commitSha: 'a'.repeat(40),
    shortCommitSha: 'aaaaaaa',
    changedFiles: ['src/test.ts'],
    diffStat: '1 file changed, 1 insertion(+)',
    commitExists: true,
    checkSummary: { test: 'pass' },
    safety: {
      commitShaIsFullLength: true,
      branchIsNotMain: true,
      hasChangedFiles: true,
    },
    ...overrides,
  };
}

const validAccepted = JSON.stringify({
  decision: 'accepted',
  confidence: 'high',
  blocking_issues: [],
  non_blocking_issues: [],
  review_summary: 'Looks good',
  fix_task: null,
  next_action: 'advance_to_next_task',
});

// Exact real failure: native JSON.parse wording that must be classified
// structurally, never by substring.
const NATIVE_PARSE_MESSAGE = "Expected property name or '}' in JSON at position 1 (line 1 column 2)";

describe('reviewer-output-parser typed failures', () => {
  test('malformed top-level JSON throws ReviewerOutputParseError', () => {
    assert.throws(
      () => parseReviewerDecisionText('{invalid'),
      (err: unknown) => {
        assert(err instanceof ReviewerOutputParseError, 'must be the typed parse error');
        return true;
      }
    );
  });

  test('missing reviewer fields throws ReviewerOutputParseError', () => {
    assert.throws(
      () => parseReviewerDecisionText('{"decision":"accepted"}'),
      (err: unknown) => err instanceof ReviewerOutputParseError
    );
  });

  test('invalid reviewer schema throws ReviewerOutputParseError', () => {
    assert.throws(
      () =>
        parseReviewerDecisionText(
          '{"decision":"unknown","confidence":"high","blocking_issues":[],"non_blocking_issues":[],"review_summary":"x","fix_task":null,"next_action":"advance_to_next_task"}'
        ),
      (err: unknown) => {
        assert(err instanceof ReviewerOutputParseError);
        assert((err as Error).message.includes('decision must be'));
        return true;
      }
    );
  });

  test('sanitizeRawOutput caps size, redacts secrets, stores hash and length', () => {
    const secret = 'sk-live-secret-abc123';
    const big = `${secret} ` + 'x'.repeat(10000);
    const sanitized = sanitizeRawOutput(big);
    assert.ok(!sanitized.excerptMasked.includes(secret), 'secret must be redacted');
    assert.ok(sanitized.excerptMasked.length <= 200 + 3, 'excerpt must be capped');
    assert.ok(sanitized.length > 0 && sanitized.length <= big.length, 'length is the redacted length');
    assert.strictEqual(sanitized.sha256.length, 64);
    assert.strictEqual(sanitized.truncated, true);
  });
});

describe('kimi reviewer provider propagates parse failures structurally', () => {
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

  test('malformed provider text surfaces ReviewerOutputParseError, not KimiProviderError', async () => {
    const fakeFetch: FetchFn = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: '{broken' } }] }),
    });
    const provider = createKimiReviewerProvider(
      { provider: 'kimi', model: 'kimi-k2.6' },
      { allowReal: true, apiKey: 'sk-test', baseUrl: 'https://api.example.com', fetchFn: fakeFetch }
    );
    await assert.rejects(
      async () => provider.reviewCommit(buildInput()),
      (err: unknown) => {
        assert(err instanceof ReviewerOutputParseError, `expected typed parse error, got: ${err}`);
        assert.strictEqual((err as ReviewerOutputParseError).name, 'ReviewerOutputParseError');
        return true;
      }
    );
  });

  test('quota 403 still surfaces as wrapped provider failure', async () => {
    const fakeFetch: FetchFn = async () => ({
      ok: false,
      status: 403,
      json: async () => ({ error: { code: 'insufficient_quota', message: 'quota exceeded' } }),
    });
    const provider = createKimiReviewerProvider(
      { provider: 'kimi', model: 'kimi-k2.6' },
      { allowReal: true, apiKey: 'sk-test', baseUrl: 'https://api.example.com', fetchFn: fakeFetch }
    );
    await assert.rejects(
      async () => provider.reviewCommit(buildInput()),
      (err: unknown) => {
        assert(!(err instanceof ReviewerOutputParseError), 'quota failure must not be a parse error');
        assert((err as Error).message.includes('403'));
        return true;
      }
    );
  });
});

describe('reviewer gate parse recovery (runner level)', () => {
  test('native JSON.parse SyntaxError message is classified as parse failure and retried', async () => {
    let calls = 0;
    const result = await runReviewerGateWithProvider({
      evidence: buildEvidence(),
      reviewer: async () => {
        calls++;
        if (calls === 1) {
          throw new ReviewerOutputParseError(NATIVE_PARSE_MESSAGE, '{broken');
        }
        return validAccepted;
      },
      maxParseRetries: 1,
    });
    assert.strictEqual(calls, 2);
    assert.strictEqual(result.gateResult.status, 'accepted');
    assert.strictEqual(result.gateResult.parseAttempts, 2);
    assert.ok(result.lastParseError);
    assert.ok(result.lastMalformedRaw);
    assert.strictEqual(result.lastMalformedRaw.excerptMasked.includes('{broken'), true);
  });

  test('recovery prompt explicitly asks for a single valid JSON object', async () => {
    const inputs: ReviewerInput[] = [];
    const result = await runReviewerGateWithProvider({
      evidence: buildEvidence(),
      reviewer: async (input: ReviewerInput) => {
        inputs.push(input);
        return inputs.length === 1 ? '{bad' : validAccepted;
      },
      maxParseRetries: 1,
    });
    assert.strictEqual(result.gateResult.status, 'accepted');
    assert.strictEqual(inputs.length, 2);
    const repair = inputs[1].previousFailure ?? '';
    assert.ok(repair.includes('single valid JSON object'), `repair prompt was: ${repair}`);
  });

  test('parse exhaustion blocks with source=parser and explicit exhaustion reason', async () => {
    let calls = 0;
    const result = await runReviewerGateWithProvider({
      evidence: buildEvidence(),
      reviewer: async () => {
        calls++;
        throw new ReviewerOutputParseError(NATIVE_PARSE_MESSAGE, '{broken');
      },
      maxParseRetries: 2,
    });
    assert.strictEqual(calls, 3, 'bounded retries only');
    assert.strictEqual(result.gateResult.status, 'blocked');
    assert.strictEqual(result.gateResult.source, 'parser');
    assert.strictEqual(result.gateResult.provider_failure, undefined);
    assert.ok(
      result.gateResult.blockingIssues.join(' ').includes('remained invalid after 3 parse attempt'),
      `blocking issues: ${result.gateResult.blockingIssues.join(' ')}`
    );
    assert.ok(result.parseFailure);
  });

  test('non-parse provider failure still blocks as source=provider without retries', async () => {
    let calls = 0;
    const result = await runReviewerGateWithProvider({
      evidence: buildEvidence(),
      reviewer: async () => {
        calls++;
        throw new Error('network failure');
      },
      maxParseRetries: 2,
    });
    assert.strictEqual(calls, 1);
    assert.strictEqual(result.gateResult.status, 'blocked');
    assert.strictEqual(result.gateResult.source, 'provider');
    assert.strictEqual(result.lastMalformedRaw, undefined);
  });

  test('malformed raw evidence is sanitized (no secrets) and bounded', async () => {
    const secret = 'sk-runner-secret-xyz';
    const result = await runReviewerGateWithProvider({
      evidence: buildEvidence(),
      reviewer: async () => `{bad ${secret} ${'y'.repeat(9000)}`,
      maxParseRetries: 0,
    });
    const raw = result.lastMalformedRaw;
    assert.ok(raw);
    assert.ok(!raw.excerptMasked.includes(secret), 'persisted excerpt must be redacted');
    assert.ok(!JSON.stringify(result.gateResult.blockingIssues).includes(secret));
    assert.ok(raw.excerptMasked.length <= 203);
    assert.strictEqual(raw.truncated, true);
    assert.strictEqual(raw.sha256.length, 64);
  });
});

// ---------------------------------------------------------------------------
// Full-flow regression: the exact real Stage 18.26 failure.
// ---------------------------------------------------------------------------

const ENV_KEYS = [
  'KIMI_FAKE_RESPONSE',
  'KIMI_FAKE_RESPONSES',
  'REAL_REPO_REVIEWER_FAKE_RESPONSE',
  'REAL_REPO_REVIEWER_SECOND_FAKE_RESPONSE',
  'REAL_REPO_REVIEWER_SECOND_FAKE_RESPONSES',
  'REAL_REPO_REVIEWER_FIX_TASK_KIMI_FAKE_RESPONSE',
  'REAL_REPO_REVIEWER_FIX_TASK_KIMI_FAKE_RESPONSES',
  'REAL_PROVIDER_MAX_ATTEMPTS',
  'REAL_PROVIDER_RETRY_BASE_MS',
  'REAL_PROVIDER_RETRY_MAX_MS',
] as const;

function snapshotEnv(): Map<string, string | undefined> {
  const snap = new Map<string, string | undefined>();
  for (const key of ENV_KEYS) snap.set(key, process.env[key]);
  return snap;
}

function restoreEnv(snap: Map<string, string | undefined>): void {
  for (const [key, value] of snap) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function fastRetries(): void {
  process.env.REAL_PROVIDER_RETRY_BASE_MS = '0';
  process.env.REAL_PROVIDER_RETRY_MAX_MS = '0';
}

function git(args: string[], cwd: string): string {
  const r = spawnSync('git', args, { cwd, encoding: 'utf-8', shell: false });
  if (r.status !== 0) throw new Error(`git ${args[0]} failed: ${r.stderr}`);
  return r.stdout;
}

function makeTempRepo(name: string): { path: string; baseSha: string } {
  const root = mkdtempSync(join(tmpdir(), `parse-recovery-${name}-`));
  const repoPath = join(root, 'repo');
  const remotePath = join(root, 'remote.git');
  mkdirSync(repoPath, { recursive: true });
  mkdirSync(remotePath, { recursive: true });
  git(['init', '--bare'], remotePath);
  git(['init'], repoPath);
  git(['config', 'user.email', 'test@example.com'], repoPath);
  git(['config', 'user.name', 'Test'], repoPath);
  writeFileSync(join(repoPath, 'README.md'), '# base\n', 'utf-8');
  git(['add', 'README.md'], repoPath);
  git(['commit', '-m', 'base'], repoPath);
  git(['remote', 'add', 'origin', remotePath], repoPath);
  git(['push', 'origin', 'HEAD:main'], repoPath);
  const baseSha = git(['rev-parse', 'HEAD'], repoPath).trim();
  git(['checkout', '-b', 'mission-parse', baseSha], repoPath);
  git(['push', 'origin', 'HEAD:mission-parse'], repoPath);
  git(['checkout', 'main'], repoPath);
  return { path: repoPath, baseSha };
}

function makeTask(repoPath: string): Task {
  return {
    id: 'parse-recovery-task',
    title: 'Parse recovery task',
    repo_path: repoPath,
    base_branch: 'main',
    work_branch: 'mission-parse',
    goal: 'Add docs/parse.md',
    context_files: [],
    checks: [],
    guardrails: {
      allow_modify: ['docs/parse.md'],
      deny_modify: ['.env'],
      auto_commit: true,
      auto_push: true,
    },
  };
}

const CODER_OUTPUT = JSON.stringify({
  mode: 'file_update',
  files: [{ path: 'docs/parse.md', content: '# v1\n' }],
});

const FIX_CODER_OUTPUT = JSON.stringify({
  mode: 'file_update',
  files: [{ path: 'docs/parse.md', content: '# v2\nmore detail\n' }],
});

const REVIEWER_FIX_REQUIRED = JSON.stringify({
  decision: 'rejected',
  confidence: 'high',
  blocking_issues: ['Document needs more detail'],
  non_blocking_issues: [],
  review_summary: 'Please expand the document.',
  fix_task: 'Expand docs/parse.md with more detail.',
  next_action: 'send_fix_to_coder',
});

const REVIEWER_ACCEPT = JSON.stringify({
  decision: 'accepted',
  confidence: 'high',
  blocking_issues: [],
  non_blocking_issues: [],
  review_summary: 'Looks good.',
  fix_task: null,
  next_action: 'advance_to_next_task',
});

interface ReviewerCallRecord {
  packageHash: string | undefined;
  hadRecoveryPrompt: boolean;
}

/**
 * Drives the real Kimi reviewer provider through globalThis.fetch (the flow
 * prefers globalThis.fetch for reviewer calls). Coder calls go through the
 * fetchFn passed to the flow.
 */
function makeReviewerFetch(script: (callIndex: number) => string): {
  fetchFn: FetchFn;
  calls: ReviewerCallRecord[];
} {
  const calls: ReviewerCallRecord[] = [];
  const fetchFn: FetchFn = async (_url, init) => {
    const body = init?.body ? JSON.parse(init.body as string) : {};
    const content: string = body.messages?.[0]?.content ?? '';
    if (!content.includes('You are a strict AI code reviewer.')) {
      throw new Error('global fetch must only serve reviewer calls in this test');
    }
    const hashMatch = /# Candidate Package Hash\n([0-9a-f]+)/.exec(content);
    calls.push({
      packageHash: hashMatch?.[1],
      hadRecoveryPrompt: content.includes('single valid JSON object'),
    });
    return {
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: script(calls.length) } }] }),
    };
  };
  return { fetchFn, calls };
}

const coderFetch: FetchFn = async () => ({
  ok: true,
  status: 200,
  json: async () => ({ choices: [{ message: { content: CODER_OUTPUT } }] }),
});

describe('real failure regression: malformed second reviewer output', () => {
  test('reviewer#1 fix_required → one fix coder → malformed reviewer#2 → parse retry → accepted', async () => {
    const envSnap = snapshotEnv();
    fastRetries();
    const repo = makeTempRepo('ok');
    const task = makeTask(repo.path);
    const candidatePath = join(tmpdir(), `parse-cand-ok-${Date.now()}`);
    const runsDir = mkdtempSync(join(tmpdir(), 'parse-runs-ok-'));
    const originalFetch = globalThis.fetch;
    const reviewer = makeReviewerFetch((i) => {
      if (i === 1) return REVIEWER_FIX_REQUIRED;
      if (i === 2) return `{broken ${"Expected property name or '}' in JSON at position 1 (line 1 column 2)"}`;
      return REVIEWER_ACCEPT;
    });
    globalThis.fetch = reviewer.fetchFn as typeof fetch;
    process.env.REAL_REPO_REVIEWER_FIX_TASK_KIMI_FAKE_RESPONSE = FIX_CODER_OUTPUT;
    try {
      const result = await runRealRepoRunAICandidateFlow({
        task,
        taskBaseSha: repo.baseSha,
        candidatePath,
        runId: `run-parse-ok-${Date.now()}`,
        isResume: false,
        maxAttempts: 1,
        reviewerMaxFixAttempts: 2,
        reviewerParseRetries: 1,
        apiKey: 'sk-test',
        baseUrl: 'https://api.example.com',
        model: 'kimi-k2.6',
        fetchFn: coderFetch,
        runsDir,
      });

      assert.strictEqual(result.exitCode, 0, `expected success, got state: ${JSON.stringify(result.state)}`);
      assert.strictEqual(result.state.status, 'pushed');

      // Call counts prove coder/fix work was not repeated. Parse retries are
      // internal to the reviewer gate, so provider_attempts has one entry per
      // gate; fetch-level reviewer.calls below proves the retry count.
      const attempts = result.state.provider_attempts ?? [];
      const count = (type: string) => attempts.filter((a) => a.type === type).length;
      assert.strictEqual(count('initial_coder'), 1, 'planner/initial coder must not rerun');
      assert.strictEqual(count('reviewer'), 1, 'reviewer #1 must not rerun');
      assert.strictEqual(count('reviewer_fix_coder'), 1, 'fix coder must run exactly once');
      assert.strictEqual(count('second_reviewer'), 1, 'one second-reviewer gate (with internal parse retry)');

      // Reviewer fetch saw exactly 3 reviewer calls with identical candidate
      // package hash across the two second-review parse attempts.
      assert.strictEqual(reviewer.calls.length, 3);
      assert.strictEqual(reviewer.calls[1].packageHash, reviewer.calls[2].packageHash);
      assert.strictEqual(reviewer.calls[2].hadRecoveryPrompt, true, 'retry must carry the recovery prompt');

      // Reviewer round stays 1 throughout the malformed retry (reviewer_round
      // itself is cleared during finalization; the round evidence proves it).
      assert.strictEqual(result.state.reviewer_rounds?.[1].reviewer_round, 1);

      // Persisted append-only reviewer round evidence.
      const rounds = result.state.reviewer_rounds ?? [];
      assert.strictEqual(rounds.length, 2, 'one evidence record per reviewer round');
      const round0 = rounds[0];
      assert.strictEqual(round0.reviewer_round, 0);
      assert.strictEqual(round0.reviewer_type, 'reviewer');
      assert.strictEqual(round0.status, 'fix_required');
      assert.deepStrictEqual(round0.blockingIssues, ['Document needs more detail']);
      assert.strictEqual(round0.fixTask, 'Expand docs/parse.md with more detail.');
      const round1 = rounds[1];
      assert.strictEqual(round1.reviewer_round, 1);
      assert.strictEqual(round1.reviewer_type, 'second_reviewer');
      assert.strictEqual(round1.status, 'accepted');
      assert.strictEqual(round1.parse_attempts, 2);
      // Same-candidate guarantee across parse retries is proven by the fetch
      // records above (calls[1] and calls[2] carry the same package hash).
      assert.ok(round1.parser_error, 'malformed parser error persisted');
      assert.ok(round1.malformed_raw_excerpt, 'sanitized malformed raw output persisted');
      assert.ok(typeof round1.malformed_raw_sha256 === 'string' && round1.malformed_raw_sha256.length === 64);
      assert.ok(typeof round1.malformed_raw_length === 'number');
      // Round-0 evidence not overwritten by round 1.
      assert.deepStrictEqual(round0.blockingIssues, ['Document needs more detail']);
    } finally {
      globalThis.fetch = originalFetch;
      restoreEnv(envSnap);
      rmSync(runsDir, { recursive: true, force: true });
      rmSync(candidatePath, { recursive: true, force: true });
      rmSync(join(repo.path, '..'), { recursive: true, force: true });
    }
  });

  test('persistent malformed second reviewer blocks with source=parser (not provider pause)', async () => {
    const envSnap = snapshotEnv();
    fastRetries();
    const repo = makeTempRepo('exhaust');
    const task = makeTask(repo.path);
    const candidatePath = join(tmpdir(), `parse-cand-ex-${Date.now()}`);
    const runsDir = mkdtempSync(join(tmpdir(), 'parse-runs-ex-'));
    const originalFetch = globalThis.fetch;
    const reviewer = makeReviewerFetch((i) => (i === 1 ? REVIEWER_FIX_REQUIRED : '{still broken'));
    globalThis.fetch = reviewer.fetchFn as typeof fetch;
    process.env.REAL_REPO_REVIEWER_FIX_TASK_KIMI_FAKE_RESPONSE = FIX_CODER_OUTPUT;
    try {
      const result = await runRealRepoRunAICandidateFlow({
        task,
        taskBaseSha: repo.baseSha,
        candidatePath,
        runId: `run-parse-ex-${Date.now()}`,
        isResume: false,
        maxAttempts: 1,
        reviewerMaxFixAttempts: 2,
        reviewerParseRetries: 1,
        apiKey: 'sk-test',
        baseUrl: 'https://api.example.com',
        model: 'kimi-k2.6',
        fetchFn: coderFetch,
        runsDir,
      });

      assert.strictEqual(result.exitCode, 1);
      assert.strictEqual(result.state.status, 'blocked');
      assert.notStrictEqual(result.state.task_phase, 'reviewer_pending');
      assert.notStrictEqual(result.state.status, 'paused_provider');
      assert.strictEqual(result.state.provider_failure, undefined);
      assert.strictEqual(result.state.reviewer_gate?.source, 'parser');
      assert.ok(
        result.state.reviewer_gate?.blockingIssues.join(' ').includes('remained invalid'),
        `expected exhaustion reason, got: ${result.state.reviewer_gate?.blockingIssues}`
      );

      const attempts = result.state.provider_attempts ?? [];
      const count = (type: string) => attempts.filter((a) => a.type === type).length;
      assert.strictEqual(count('reviewer_fix_coder'), 1, 'no additional fix coder calls');
      assert.strictEqual(count('second_reviewer'), 1, 'one second-reviewer gate attempt record');
      assert.strictEqual(reviewer.calls.length, 3, 'reviewer#1 + 2 bounded parse attempts at fetch level');

      const rounds = result.state.reviewer_rounds ?? [];
      assert.strictEqual(rounds.length, 2);
      assert.strictEqual(rounds[1].status, 'blocked');
      assert.strictEqual(rounds[1].source, 'parser');
      assert.strictEqual(rounds[1].parse_attempts, 2);
      assert.ok(rounds[1].malformed_raw_excerpt);
    } finally {
      globalThis.fetch = originalFetch;
      restoreEnv(envSnap);
      rmSync(runsDir, { recursive: true, force: true });
      rmSync(candidatePath, { recursive: true, force: true });
      rmSync(join(repo.path, '..'), { recursive: true, force: true });
    }
  });
});

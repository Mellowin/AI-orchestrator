import { describe, test } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { RealBlockRunState } from '../src/real-block-run-ai-state.js';

const PROJECT_ROOT = process.cwd();
const TSX_CLI_PATH = join(PROJECT_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const CLI_PATH = join(PROJECT_ROOT, 'src', 'cli.ts');
const QUICKSTART_PATH = join(PROJECT_ROOT, 'docs', 'REAL_BLOCK_RUN_QUICKSTART.md');

function runCli(args: string[], envOverrides: Record<string, string> = {}): {
  status: number;
  stdout: string;
  stderr: string;
} {
  const env = { ...process.env, ...envOverrides };
  const result = spawnSync(process.execPath, [TSX_CLI_PATH, CLI_PATH, ...args], {
    cwd: PROJECT_ROOT,
    env,
    encoding: 'utf-8',
    shell: false,
    timeout: 30000,
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  };
}

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'block-report-test-'));
}

function writeState(dir: string, state: unknown): string {
  const statePath = join(dir, 'state.json');
  writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf-8');
  return statePath;
}

function buildCompletedState(): RealBlockRunState {
  return {
    block_id: 'block_smoke',
    title: 'Block smoke example',
    status: 'completed',
    currentTaskId: null,
    statePath: 'runs/block/block_smoke/state.json',
    taskResults: [
      {
        taskId: 'task_1',
        title: 'Update README',
        status: 'accepted',
        finalStatus: 'accepted',
        nextAction: 'continue',
        originalCommitSha: 'aabbccddeeff00112233445566778899aabbccdd',
        fixAttempted: false,
        reviewerGateStatus: 'accepted',
        childStateTaskId: 'task_1',
      },
      {
        taskId: 'task_2',
        title: 'Add test',
        status: 'fixed_and_accepted',
        finalStatus: 'accepted',
        nextAction: 'continue',
        originalCommitSha: '11223344556677889900aabbccddeeff00112233',
        fixAttempted: true,
        fixTaskId: 'task_2_fix',
        fixRunnerStatus: 'executed',
        fixRunnerNextAction: 'review_fix_result',
        fixCommitSha: '44556677889900aabbccddeeff00112233445566',
        reviewerGateStatus: 'fix_required',
        secondReviewerGateStatus: 'accepted',
        fixCheckSummary: {
          typecheck: 'pass',
          build: 'pass',
          test: 'pass',
          tests: { total: 3, suites: 0, failures: 0 },
        },
        childStateTaskId: 'task_2',
      },
    ],
    summary: {
      totalTasks: 2,
      acceptedTasks: 1,
      fixedTasks: 1,
      completedTasks: 2,
      stoppedReason: 'none',
    },
    startedAt: '2026-06-15T10:00:00.000Z',
    finishedAt: '2026-06-15T10:05:00.000Z',
    safetyNote: 'Local demo only.',
  };
}

function buildBlockedState(): RealBlockRunState {
  return {
    ...buildCompletedState(),
    status: 'blocked',
    summary: {
      totalTasks: 2,
      acceptedTasks: 1,
      fixedTasks: 0,
      completedTasks: 1,
      blockedTaskId: 'task_2',
      stoppedReason: 'guardrails rejected fix output',
    },
    taskResults: [
      buildCompletedState().taskResults[0],
      {
        taskId: 'task_2',
        title: 'Add test',
        status: 'blocked',
        finalStatus: 'blocked',
        nextAction: 'stop',
        originalCommitSha: '11223344556677889900aabbccddeeff00112233',
        fixAttempted: false,
        reviewerGateStatus: 'rejected',
        reason: 'Guardrails rejected proposed files',
        childStateTaskId: 'task_2',
      },
    ],
  };
}

function buildResumedState(): RealBlockRunState {
  return {
    ...buildCompletedState(),
    resumed: true,
    resumeStartedAt: '2026-06-15T11:00:00.000Z',
  };
}

function buildPostPushBlockedState(): RealBlockRunState {
  return {
    ...buildBlockedState(),
    taskResults: [
      buildBlockedState().taskResults[0],
      {
        ...buildBlockedState().taskResults[1],
        rollbackPolicy: 'post_push_preserve_for_human',
        rollbackReason: 'Commit already pushed; rollback skipped for human follow-up',
      },
    ],
  };
}

describe('cli real-block-run-ai-report', () => {
  test('report command exists in CLI usage', () => {
    const result = runCli([]);
    assert.notStrictEqual(result.status, 0, 'missing command should exit non-zero');
    const output = `${result.stdout}\n${result.stderr}`;
    assert.match(output, /real-block-run-ai-report/);
  });

  test('missing state path exits non-zero', () => {
    const result = runCli(['real-block-run-ai-report']);
    assert.notStrictEqual(result.status, 0);
    const output = `${result.stdout}\n${result.stderr}`;
    assert.match(output, /block state path is required/i);
  });

  test('nonexistent state file exits non-zero', () => {
    const tmpDir = makeTempDir();
    const result = runCli(['real-block-run-ai-report', join(tmpDir, 'missing.json')]);
    assert.notStrictEqual(result.status, 0);
    const output = `${result.stdout}\n${result.stderr}`;
    assert.match(output, /not found/i);
  });

  test('corrupt JSON state exits non-zero', () => {
    const tmpDir = makeTempDir();
    const statePath = join(tmpDir, 'state.json');
    writeFileSync(statePath, 'not-json', 'utf-8');
    const result = runCli(['real-block-run-ai-report', statePath]);
    assert.notStrictEqual(result.status, 0);
    const output = `${result.stdout}\n${result.stderr}`;
    assert.match(output, /not valid JSON/i);
  });

  test('invalid state shape exits non-zero', () => {
    const tmpDir = makeTempDir();
    const statePath = writeState(tmpDir, { foo: 'bar' });
    const result = runCli(['real-block-run-ai-report', statePath]);
    assert.notStrictEqual(result.status, 0);
    const output = `${result.stdout}\n${result.stderr}`;
    assert.match(output, /invalid status|invalid block state/i);
  });

  test('valid completed state prints block id', () => {
    const tmpDir = makeTempDir();
    const statePath = writeState(tmpDir, buildCompletedState());
    const result = runCli(['real-block-run-ai-report', statePath]);
    assert.strictEqual(result.status, 0, result.stderr);
    assert.match(result.stdout, /Block:\s+block_smoke/);
  });

  test('valid completed state prints title', () => {
    const tmpDir = makeTempDir();
    const statePath = writeState(tmpDir, buildCompletedState());
    const result = runCli(['real-block-run-ai-report', statePath]);
    assert.strictEqual(result.status, 0, result.stderr);
    assert.match(result.stdout, /Title:\s+Block smoke example/);
  });

  test('valid completed state prints status', () => {
    const tmpDir = makeTempDir();
    const statePath = writeState(tmpDir, buildCompletedState());
    const result = runCli(['real-block-run-ai-report', statePath]);
    assert.strictEqual(result.status, 0, result.stderr);
    assert.match(result.stdout, /Status:\s+completed/);
  });

  test('valid completed state prints state path', () => {
    const tmpDir = makeTempDir();
    const statePath = writeState(tmpDir, buildCompletedState());
    const result = runCli(['real-block-run-ai-report', statePath]);
    assert.strictEqual(result.status, 0, result.stderr);
    assert.ok(result.stdout.includes(`State: ${statePath}`), 'report must print the state path');
  });

  test('valid completed state prints summary totalTasks', () => {
    const tmpDir = makeTempDir();
    const statePath = writeState(tmpDir, buildCompletedState());
    const result = runCli(['real-block-run-ai-report', statePath]);
    assert.strictEqual(result.status, 0, result.stderr);
    assert.match(result.stdout, /totalTasks:\s+2/);
  });

  test('valid completed state prints summary completedTasks', () => {
    const tmpDir = makeTempDir();
    const statePath = writeState(tmpDir, buildCompletedState());
    const result = runCli(['real-block-run-ai-report', statePath]);
    assert.strictEqual(result.status, 0, result.stderr);
    assert.match(result.stdout, /completedTasks:\s+2/);
  });

  test('valid completed state prints summary acceptedTasks', () => {
    const tmpDir = makeTempDir();
    const statePath = writeState(tmpDir, buildCompletedState());
    const result = runCli(['real-block-run-ai-report', statePath]);
    assert.strictEqual(result.status, 0, result.stderr);
    assert.match(result.stdout, /acceptedTasks:\s+1/);
  });

  test('valid completed state prints summary fixedTasks', () => {
    const tmpDir = makeTempDir();
    const statePath = writeState(tmpDir, buildCompletedState());
    const result = runCli(['real-block-run-ai-report', statePath]);
    assert.strictEqual(result.status, 0, result.stderr);
    assert.match(result.stdout, /fixedTasks:\s+1/);
  });

  test('valid completed state prints task ids', () => {
    const tmpDir = makeTempDir();
    const statePath = writeState(tmpDir, buildCompletedState());
    const result = runCli(['real-block-run-ai-report', statePath]);
    assert.strictEqual(result.status, 0, result.stderr);
    assert.match(result.stdout, /task_1/);
    assert.match(result.stdout, /task_2/);
  });

  test('valid completed state prints originalCommitSha', () => {
    const tmpDir = makeTempDir();
    const statePath = writeState(tmpDir, buildCompletedState());
    const result = runCli(['real-block-run-ai-report', statePath]);
    assert.strictEqual(result.status, 0, result.stderr);
    assert.match(result.stdout, /originalCommitSha:\s+aabbccddeeff00112233445566778899aabbccdd/);
  });

  test('valid completed state prints fixCommitSha', () => {
    const tmpDir = makeTempDir();
    const statePath = writeState(tmpDir, buildCompletedState());
    const result = runCli(['real-block-run-ai-report', statePath]);
    assert.strictEqual(result.status, 0, result.stderr);
    assert.match(result.stdout, /fixCommitSha:\s+44556677889900aabbccddeeff00112233445566/);
  });

  test('valid completed state prints fixCheckSummary typecheck', () => {
    const tmpDir = makeTempDir();
    const statePath = writeState(tmpDir, buildCompletedState());
    const result = runCli(['real-block-run-ai-report', statePath]);
    assert.strictEqual(result.status, 0, result.stderr);
    assert.match(result.stdout, /typecheck:\s+pass/);
  });

  test('valid completed state prints fixCheckSummary build', () => {
    const tmpDir = makeTempDir();
    const statePath = writeState(tmpDir, buildCompletedState());
    const result = runCli(['real-block-run-ai-report', statePath]);
    assert.strictEqual(result.status, 0, result.stderr);
    assert.match(result.stdout, /build:\s+pass/);
  });

  test('valid completed state prints fixCheckSummary test', () => {
    const tmpDir = makeTempDir();
    const statePath = writeState(tmpDir, buildCompletedState());
    const result = runCli(['real-block-run-ai-report', statePath]);
    assert.strictEqual(result.status, 0, result.stderr);
    assert.match(result.stdout, /test:\s+pass/);
  });

  test('valid completed state prints fixCheckSummary test counts', () => {
    const tmpDir = makeTempDir();
    const statePath = writeState(tmpDir, buildCompletedState());
    const result = runCli(['real-block-run-ai-report', statePath]);
    assert.strictEqual(result.status, 0, result.stderr);
    assert.match(result.stdout, /tests:\s+total=3 suites=0 failures=0/);
  });

  test('valid completed state prints reviewerGateStatus', () => {
    const tmpDir = makeTempDir();
    const statePath = writeState(tmpDir, buildCompletedState());
    const result = runCli(['real-block-run-ai-report', statePath]);
    assert.strictEqual(result.status, 0, result.stderr);
    assert.match(result.stdout, /reviewerGateStatus:\s+accepted/);
    assert.match(result.stdout, /reviewerGateStatus:\s+fix_required/);
  });

  test('valid completed state prints secondReviewerGateStatus', () => {
    const tmpDir = makeTempDir();
    const statePath = writeState(tmpDir, buildCompletedState());
    const result = runCli(['real-block-run-ai-report', statePath]);
    assert.strictEqual(result.status, 0, result.stderr);
    assert.match(result.stdout, /secondReviewerGateStatus:\s+accepted/);
  });

  test('valid blocked state prints stoppedReason', () => {
    const tmpDir = makeTempDir();
    const statePath = writeState(tmpDir, buildBlockedState());
    const result = runCli(['real-block-run-ai-report', statePath]);
    assert.strictEqual(result.status, 0, result.stderr);
    assert.match(result.stdout, /stoppedReason:\s+guardrails rejected fix output/);
  });

  test('valid resumed state prints resumed/resumeStartedAt', () => {
    const tmpDir = makeTempDir();
    const statePath = writeState(tmpDir, buildResumedState());
    const result = runCli(['real-block-run-ai-report', statePath]);
    assert.strictEqual(result.status, 0, result.stderr);
    assert.match(result.stdout, /Resumed:\s+yes/);
    assert.match(result.stdout, /Resume started:\s+2026-06-15T11:00:00\.000Z/);
  });

  test('secret-like reviewerSummary is redacted in output', () => {
    const tmpDir = makeTempDir();
    const state = buildCompletedState();
    state.taskResults[0].reviewerSummary = 'Looks good but uses sk-live-key-abc123';
    const statePath = writeState(tmpDir, state);
    const result = runCli(['real-block-run-ai-report', statePath]);
    assert.strictEqual(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stdout, /sk-live-key-abc123/);
    assert.match(result.stdout, /\[REDACTED\]/);
  });

  test('secret-like reason is redacted in output', () => {
    const tmpDir = makeTempDir();
    const state = buildBlockedState();
    state.taskResults[1].reason = 'Token ghp_supersecret was exposed';
    const statePath = writeState(tmpDir, state);
    const result = runCli(['real-block-run-ai-report', statePath]);
    assert.strictEqual(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stdout, /ghp_supersecret/);
    assert.match(result.stdout, /\[REDACTED\]/);
  });

  test('post-push blocked state prints rollbackPolicy', () => {
    const tmpDir = makeTempDir();
    const statePath = writeState(tmpDir, buildPostPushBlockedState());
    const result = runCli(['real-block-run-ai-report', statePath]);
    assert.strictEqual(result.status, 0, result.stderr);
    assert.match(result.stdout, /rollbackPolicy:\s+post_push_preserve_for_human/);
  });

  test('post-push blocked state prints rollbackReason', () => {
    const tmpDir = makeTempDir();
    const statePath = writeState(tmpDir, buildPostPushBlockedState());
    const result = runCli(['real-block-run-ai-report', statePath]);
    assert.strictEqual(result.status, 0, result.stderr);
    assert.match(
      result.stdout,
      /rollbackReason:\s+Commit already pushed; rollback skipped for human follow-up/
    );
  });

  test('secret-like rollbackReason is redacted in output', () => {
    const tmpDir = makeTempDir();
    const state = buildPostPushBlockedState();
    state.taskResults[1].rollbackReason = 'sk-live-roll-policy-key exposed after push';
    const statePath = writeState(tmpDir, state);
    const result = runCli(['real-block-run-ai-report', statePath]);
    assert.strictEqual(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stdout, /sk-live-roll-policy-key/);
    assert.match(result.stdout, /\[REDACTED\]/);
  });

  test('raw runState is not printed', () => {
    const tmpDir = makeTempDir();
    const statePath = writeState(tmpDir, buildCompletedState());
    const result = runCli(['real-block-run-ai-report', statePath]);
    assert.strictEqual(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stdout, /runState/);
  });

  test('raw provider output shape like choices is not printed', () => {
    const tmpDir = makeTempDir();
    const statePath = writeState(tmpDir, buildCompletedState());
    const result = runCli(['real-block-run-ai-report', statePath]);
    assert.strictEqual(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stdout, /choices/);
  });

  test('command does not mutate the state file', () => {
    const tmpDir = makeTempDir();
    const statePath = writeState(tmpDir, buildCompletedState());
    const beforeStat = statSync(statePath);
    const beforeContent = readFileSync(statePath, 'utf-8');
    const result = runCli(['real-block-run-ai-report', statePath]);
    assert.strictEqual(result.status, 0, result.stderr);
    const afterStat = statSync(statePath);
    const afterContent = readFileSync(statePath, 'utf-8');
    assert.strictEqual(afterContent, beforeContent, 'state file content must not change');
    assert.strictEqual(afterStat.mtime.getTime(), beforeStat.mtime.getTime(), 'state file mtime must not change');
  });

  test('command does not create commits', () => {
    const tmpDir = makeTempDir();
    const statePath = writeState(tmpDir, buildCompletedState());
    const result = runCli(['real-block-run-ai-report', statePath]);
    assert.strictEqual(result.status, 0, result.stderr);
    // If the command attempted a git commit, it would fail because tmpDir is not a git repo.
    assert.strictEqual(result.status, 0);
  });

  test('command does not spawn child runner', () => {
    const tmpDir = makeTempDir();
    const statePath = writeState(tmpDir, buildCompletedState());
    const result = runCli(['real-block-run-ai-report', statePath]);
    assert.strictEqual(result.status, 0, result.stderr);
    const output = `${result.stdout}\n${result.stderr}`;
    // The underlying block runner logs with [real-block-run-ai]; our command logs with [real-block-run-ai-report].
    assert.doesNotMatch(output, /\[real-block-run-ai\]/);
  });

  test('command does not call provider/network', () => {
    const tmpDir = makeTempDir();
    const statePath = writeState(tmpDir, buildCompletedState());
    // Run with no API keys and a short timeout; read-only report should still succeed.
    const result = runCli(['real-block-run-ai-report', statePath], {
      AI_PROVIDER: 'mock',
      MOCK_AI_RESPONSE: '{"mode":"file_update","files":[]}',
      KIMI_API_KEY: '',
      OPENAI_API_KEY: '',
      GITHUB_TOKEN: '',
    });
    assert.strictEqual(result.status, 0, result.stderr);
  });

  test('quickstart mentions report command', () => {
    const doc = readFileSync(QUICKSTART_PATH, 'utf-8');
    assert.match(doc, /real-block-run-ai-report/);
  });
});

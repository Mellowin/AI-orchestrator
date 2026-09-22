import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  GIT_WRITE_AUTH_PREFLIGHT_REF,
  runGitWriteAuthPreflight,
} from '../src/git-write-auth-preflight.js';
import { runAutopilotOneClick } from '../src/autopilot-one-click/runner.js';

type FakeGitResult = { status: number; stdout: string; stderr: string };

function makeFakeSpawn(
  handler: (args: string[]) => FakeGitResult,
  calls: string[][]
): typeof spawnSync {
  return ((_cmd: string, args: string[]) => {
    calls.push([...args]);
    const r = handler(args);
    return { status: r.status, stdout: r.stdout, stderr: r.stderr, pid: 0, output: [], signal: null };
  }) as unknown as typeof spawnSync;
}

const SENTINEL_TOKEN = 'ghp_SENTINELpreflighttoken000000000000000000'; // 36 chars after ghp_

function withToken<T>(value: string | undefined, fn: () => T): T {
  const prev = process.env.GITHUB_TOKEN;
  if (value === undefined) {
    delete process.env.GITHUB_TOKEN;
  } else {
    process.env.GITHUB_TOKEN = value;
  }
  try {
    return fn();
  } finally {
    if (prev === undefined) {
      delete process.env.GITHUB_TOKEN;
    } else {
      process.env.GITHUB_TOKEN = prev;
    }
  }
}

const GITHUB_REMOTE = 'https://github.com/Mellowin/AI-orchestrator.git';
const HEAD_SHA = 'a'.repeat(40);

function okHandler(overrides: Partial<Record<string, FakeGitResult>> = {}) {
  return (args: string[]): FakeGitResult => {
    if (args[0] === 'remote' && args[1] === 'get-url') {
      return overrides['get-url'] ?? { status: 0, stdout: `${GITHUB_REMOTE}\n`, stderr: '' };
    }
    if (args[0] === 'rev-parse') {
      return overrides['rev-parse'] ?? { status: 0, stdout: `${HEAD_SHA}\n`, stderr: '' };
    }
    if (args[0] === 'push') {
      return overrides['push'] ?? { status: 0, stdout: '', stderr: '' };
    }
    if (args[0] === 'ls-remote') {
      return overrides['ls-remote'] ?? { status: 0, stdout: '', stderr: '' };
    }
    return { status: 1, stdout: '', stderr: `unexpected git command: ${args.join(' ')}` };
  };
}

test('preflight: missing remote -> GIT_REMOTE_UNAVAILABLE, resumable', () => {
  const calls: string[][] = [];
  const spawnFn = makeFakeSpawn(
    () => ({ status: 128, stdout: '', stderr: 'error: No such remote' }),
    calls
  );
  const result = runGitWriteAuthPreflight({ repoPath: '.', spawnFn });
  assert.equal(result.ok, false);
  assert.equal(result.failure?.failure_kind, 'GIT_REMOTE_UNAVAILABLE');
  assert.equal(result.failure?.pause_recommended, true);
  assert.equal(result.failure?.operation, 'preflight_write_check');
  assert.deepEqual(calls, [['remote', 'get-url', 'origin']]);
});

test('preflight: GitHub HTTPS remote without GITHUB_TOKEN -> GIT_AUTH_INVALID before any push', () => {
  withToken(undefined, () => {
    const calls: string[][] = [];
    const spawnFn = makeFakeSpawn(okHandler(), calls);
    const result = runGitWriteAuthPreflight({ repoPath: '.', spawnFn });
    assert.equal(result.ok, false);
    assert.equal(result.failure?.failure_kind, 'GIT_AUTH_INVALID');
    assert.equal(result.failure?.pause_recommended, true);
    // No push or ls-remote attempted: fail-fast before touching the remote.
    assert.deepEqual(calls, [['remote', 'get-url', 'origin']]);
  });
});

test('preflight: dry-run auth failure -> GIT_AUTH_INVALID, token never in sanitized message', () => {
  withToken(SENTINEL_TOKEN, () => {
    const calls: string[][] = [];
    const authError = [
      'remote: Invalid username or token.',
      'Password authentication is not supported for Git operations.',
      `fatal: Authentication failed for 'https://x-access-token:${SENTINEL_TOKEN}@github.com/Mellowin/AI-orchestrator.git/'`,
    ].join('\n');
    const spawnFn = makeFakeSpawn(
      okHandler({ push: { status: 128, stdout: '', stderr: authError } }),
      calls
    );
    const result = runGitWriteAuthPreflight({ repoPath: '.', spawnFn });
    assert.equal(result.ok, false);
    assert.equal(result.failure?.failure_kind, 'GIT_AUTH_INVALID');
    assert.equal(result.failure?.operation, 'preflight_write_check');
    assert.equal(result.failure?.pause_recommended, true);

    const pushCall = calls.find((c) => c[0] === 'push');
    assert.ok(pushCall, 'a push must have been attempted');
    assert.ok(pushCall.includes('--dry-run'), 'push must be a dry-run');
    assert.ok(pushCall.includes('--porcelain'));
    assert.ok(
      pushCall.some((a) => a.includes(`x-access-token:${SENTINEL_TOKEN}`)),
      'push must authenticate with the injected x-access-token URL (same mechanism as real pushes)'
    );
    assert.ok(
      pushCall.some((a) => a.endsWith(`:${GIT_WRITE_AUTH_PREFLIGHT_REF}`)),
      'push must target the deterministic preflight ref'
    );
    assert.ok(!result.failure!.sanitized_message.includes(SENTINEL_TOKEN), 'token must be redacted');
    assert.ok(!result.failure!.sanitized_message.includes('x-access-token:' + SENTINEL_TOKEN));
    // Regression 17: a readable (anonymous) remote does NOT count as write auth —
    // the result is a failure even though only the write step failed.
    assert.equal(calls.some((c) => c[0] === 'ls-remote'), false, 'ls-remote must not run after a failed dry-run');
  });
});

test('preflight: happy path -> ok, every push is a dry-run, ls-remote confirms no ref created', () => {
  withToken(SENTINEL_TOKEN, () => {
    const calls: string[][] = [];
    const spawnFn = makeFakeSpawn(okHandler(), calls);
    const result = runGitWriteAuthPreflight({ repoPath: '.', spawnFn });
    assert.equal(result.ok, true);
    assert.equal(result.failure, undefined);
    const pushCalls = calls.filter((c) => c[0] === 'push');
    assert.equal(pushCalls.length, 1);
    assert.ok(pushCalls[0].includes('--dry-run'), 'preflight must never perform a real push');
    const lsRemote = calls.find((c) => c[0] === 'ls-remote');
    assert.ok(lsRemote?.includes(GIT_WRITE_AUTH_PREFLIGHT_REF));
  });
});

test('preflight: pre-existing preflight ref on remote -> GIT_REMOTE_CONFLICT, fail-closed (no pause)', () => {
  withToken(SENTINEL_TOKEN, () => {
    const calls: string[][] = [];
    const spawnFn = makeFakeSpawn(
      okHandler({
        'ls-remote': { status: 0, stdout: `${HEAD_SHA}\t${GIT_WRITE_AUTH_PREFLIGHT_REF}\n`, stderr: '' },
      }),
      calls
    );
    const result = runGitWriteAuthPreflight({ repoPath: '.', spawnFn });
    assert.equal(result.ok, false);
    assert.equal(result.failure?.failure_kind, 'GIT_REMOTE_CONFLICT');
    assert.equal(result.failure?.pause_recommended, false);
  });
});

test('preflight: unresolvable HEAD -> GIT_UNKNOWN_FAILURE, no pause', () => {
  withToken(SENTINEL_TOKEN, () => {
    const calls: string[][] = [];
    const spawnFn = makeFakeSpawn(
      okHandler({ 'rev-parse': { status: 128, stdout: '', stderr: 'fatal: ambiguous argument' } }),
      calls
    );
    const result = runGitWriteAuthPreflight({ repoPath: '.', spawnFn });
    assert.equal(result.ok, false);
    assert.equal(result.failure?.failure_kind, 'GIT_UNKNOWN_FAILURE');
    assert.equal(result.failure?.pause_recommended, false);
    assert.equal(calls.some((c) => c[0] === 'push'), false, 'must not push without a valid HEAD');
  });
});

test('preflight: real local bare remote -> ok and creates no remote ref (regression 15)', () => {
  const base = mkdtempSync(join(tmpdir(), 'write-auth-preflight-'));
  const work = join(base, 'work');
  const remote = join(base, 'remote.git');
  try {
    mkdirSync(work, { recursive: true });
    const git = (cwd: string, args: string[]) => {
      const r = spawnSync('git', args, { cwd, encoding: 'utf-8' });
      assert.equal(r.status, 0, `git ${args.join(' ')} failed: ${r.stderr}`);
      return (r.stdout || '').trim();
    };
    spawnSync('git', ['init', '--bare', remote], { encoding: 'utf-8' });
    git(work, ['init']);
    git(work, ['config', 'user.email', 'test@example.com']);
    git(work, ['config', 'user.name', 'test']);
    writeFileSync(join(work, 'file.txt'), 'hello\n');
    git(work, ['add', 'file.txt']);
    git(work, ['commit', '-m', 'init']);
    git(work, ['remote', 'add', 'origin', remote]);

    // Non-GitHub remote: no token needed, URL used as-is.
    const result = runGitWriteAuthPreflight({ repoPath: work });
    assert.equal(result.ok, true, `expected ok, got ${JSON.stringify(result.failure)}`);

    const refs = spawnSync('git', ['ls-remote', remote], { encoding: 'utf-8' });
    assert.equal(refs.status, 0);
    assert.ok(
      !(refs.stdout || '').includes('write-auth-preflight'),
      'dry-run preflight must create no remote ref'
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('one-click wiring: preflight failure pauses mission BEFORE planner (regression 14, provider calls = 0)', async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'oneclick-preflight-fail-'));
  // Provider token present: the git write-auth gate runs before the planner.
  const prevKimi = process.env.KIMI_API_KEY;
  process.env.KIMI_API_KEY = 'sk-test-preflight';
  try {
    let preflightInput: unknown;
    const result = await runAutopilotOneClick(
      'Implement multi-task feature',
      {
        preset: 'real-multitask',
        output_dir: tmpDir,
        run_id: `preflight-fail-${Date.now()}`,
        writeAuthPreflightFn: (input) => {
          preflightInput = input;
          return {
            ok: false,
            failure: {
              remote: 'origin',
              operation: 'preflight_write_check',
              failure_kind: 'GIT_AUTH_INVALID',
              http_status: null,
              pause_recommended: true,
              sanitized_message: 'Invalid username or token',
            },
          };
        },
      },
      'npx tsx src/cli.ts autopilot-one-click "goal"'
    );
    assert.ok(preflightInput !== undefined, 'preflight must be invoked');
    assert.equal(result.verdict, 'MULTITASK_MISSION_PAUSED_GIT_AUTH');
    assert.equal(result.exit_code, 1);
    assert.equal(result.resume_supported, true);
    assert.ok(result.resume_command?.endsWith(' --resume'), 'resume command must be persisted');
    assert.equal(result.git_failure?.failure_kind, 'GIT_AUTH_INVALID');
    // Planner never ran: plan_result is an empty placeholder, no provider call happened.
    assert.equal(result.plan_result?.verdict, undefined);
    assert.ok(
      result.generated_paths.some((p) => p.endsWith('one-click-report.md')),
      'a report must still be written'
    );
  } finally {
    if (prevKimi === undefined) {
      delete process.env.KIMI_API_KEY;
    } else {
      process.env.KIMI_API_KEY = prevKimi;
    }
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('one-click wiring: missing provider token keeps the legacy planner token error (preflight skipped)', async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'oneclick-preflight-notoken-'));
  const prevKimi = process.env.KIMI_API_KEY;
  delete process.env.KIMI_API_KEY;
  try {
    let preflightCalled = false;
    const result = await runAutopilotOneClick(
      'Implement multi-task feature',
      {
        preset: 'real-multitask',
        output_dir: tmpDir,
        run_id: `preflight-notoken-${Date.now()}`,
        writeAuthPreflightFn: () => {
          preflightCalled = true;
          return {
            ok: false,
            failure: {
              remote: 'origin',
              operation: 'preflight_write_check',
              failure_kind: 'GIT_AUTH_INVALID',
              http_status: null,
              pause_recommended: true,
              sanitized_message: 'Invalid username or token',
            },
          };
        },
      },
      'npx tsx src/cli.ts autopilot-one-click "goal"'
    );
    // Without a provider token the planner token gate reports first (no
    // provider call either way); the git preflight must not preempt it.
    assert.equal(preflightCalled, false);
    assert.notEqual(result.verdict, 'MULTITASK_MISSION_PAUSED_GIT_AUTH');
    assert.equal(result.plan_result?.verdict, 'AUTOPILOT_PLAN_NEEDS_PROVIDER_TOKEN');
  } finally {
    if (prevKimi === undefined) {
      delete process.env.KIMI_API_KEY;
    } else {
      process.env.KIMI_API_KEY = prevKimi;
    }
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

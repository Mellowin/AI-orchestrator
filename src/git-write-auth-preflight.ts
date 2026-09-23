import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import {
  buildEphemeralGitAuthEnv,
  stripCredentialsFromRemoteUrl,
} from './git-push-auth.js';
import {
  classifyGitRemoteFailure,
  sanitizeGitRemoteMessage,
  type StructuredGitRemoteFailure,
} from './git-remote-failure.js';

/**
 * Non-mutating Git write-auth preflight.
 *
 * Verifies that the configured GITHUB_TOKEN can WRITE to the target repository
 * before any expensive planner/coder provider call. Read-only checks such as
 * `git ls-remote` are NOT sufficient: public repositories can be read
 * anonymously. The check therefore performs a `git push --dry-run` of the
 * current HEAD to a deterministic temporary ref. Authentication uses the exact
 * same ephemeral mechanism as real candidate pushes: the token is passed via
 * GIT_CONFIG_* environment variables (http.extraHeader scoped to github.com),
 * never in the persisted remote URL and never in the command line. A dry-run
 * creates no remote ref and mutates no repository state; afterwards the
 * preflight verifies via ls-remote that the temporary ref does not exist.
 */

/** Deterministic temporary ref used only for dry-run validation. */
export const GIT_WRITE_AUTH_PREFLIGHT_REF = 'refs/heads/ai-orchestrator/write-auth-preflight';

export interface GitWriteAuthPreflightInput {
  repoPath: string;
  remote?: string;
  /** Test hook for the git command runner. */
  spawnFn?: typeof spawnSync;
}

export interface GitWriteAuthPreflightResult {
  ok: boolean;
  failure?: StructuredGitRemoteFailure;
  reason?: string;
}

const VALID_SHA = /^[0-9a-f]{40}$/i;

function buildLocalFailure(
  remote: string,
  failureKind: StructuredGitRemoteFailure['failure_kind'],
  pauseRecommended: boolean,
  message: string
): GitWriteAuthPreflightResult {
  return {
    ok: false,
    failure: {
      remote,
      operation: 'preflight_write_check',
      failure_kind: failureKind,
      http_status: null,
      pause_recommended: pauseRecommended,
      sanitized_message: sanitizeGitRemoteMessage(message),
    },
  };
}

export function runGitWriteAuthPreflight(input: GitWriteAuthPreflightInput): GitWriteAuthPreflightResult {
  const spawnFn = input.spawnFn ?? spawnSync;
  const repoPath = resolve(input.repoPath);
  const remote = input.remote ?? 'origin';

  const runGit = (
    args: string[],
    extraEnv?: Record<string, string>
  ): { status: number; stdout: string; stderr: string } => {
    const result = spawnFn('git', args, {
      cwd: repoPath,
      encoding: 'utf-8',
      shell: false,
      ...(extraEnv ? { env: { ...process.env, ...extraEnv } } : {}),
    });
    return {
      status: result.status ?? 1,
      stdout: result.stdout || '',
      stderr: result.stderr || '',
    };
  };

  const urlResult = runGit(['remote', 'get-url', remote]);
  if (urlResult.status !== 0 || urlResult.stdout.trim() === '') {
    return buildLocalFailure(
      remote,
      'GIT_REMOTE_UNAVAILABLE',
      true,
      `No git remote "${remote}" is configured in ${repoPath}`
    );
  }
  const remoteUrl = urlResult.stdout.trim();

  // Same credential mechanism as real candidate pushes: GITHUB_TOKEN supplied
  // ephemerally via GIT_CONFIG_* environment (http.extraHeader scoped to
  // github.com). No token in the persisted remote URL, no token in argv, no
  // global git config mutation, no credential-helper dependency; the canonical
  // one-click works from .env GITHUB_TOKEN alone.
  const token = process.env.GITHUB_TOKEN?.trim();
  const pushUrl = stripCredentialsFromRemoteUrl(remoteUrl);
  let authEnv: Record<string, string> = {};
  const isGithubHttps = /^https:\/\/([^/@]+\.)?github\.com\//i.test(pushUrl);
  if (isGithubHttps) {
    if (!token) {
      return buildLocalFailure(
        remote,
        'GIT_AUTH_INVALID',
        true,
        'GITHUB_TOKEN is not set; cannot verify write access to the GitHub remote'
      );
    }
    authEnv = buildEphemeralGitAuthEnv(token);
  }

  const headResult = runGit(['rev-parse', '--verify', 'HEAD']);
  const headSha = headResult.status === 0 ? headResult.stdout.trim() : '';
  if (!VALID_SHA.test(headSha)) {
    return buildLocalFailure(
      remote,
      'GIT_UNKNOWN_FAILURE',
      false,
      `Could not resolve local HEAD for the write-auth preflight: ${headResult.stderr.trim()}`
    );
  }

  // Non-mutating write check: dry-run push of the current HEAD to the
  // deterministic temporary ref. Authenticates and checks write permission
  // without creating any remote ref. The credential travels only in the child
  // process environment; failure output is sanitized by the classifier.
  const dryRun = runGit(
    ['push', '--dry-run', '--porcelain', pushUrl, `${headSha}:${GIT_WRITE_AUTH_PREFLIGHT_REF}`],
    authEnv
  );
  if (dryRun.status !== 0) {
    const failure = classifyGitRemoteFailure({
      remote,
      operation: 'preflight_write_check',
      output: dryRun.stderr || dryRun.stdout || `git push --dry-run exited with code ${dryRun.status}`,
    });
    return { ok: false, failure };
  }

  // Verify the dry-run created no remote ref. A pre-existing or unexpectedly
  // created preflight ref is a fail-closed repository conflict.
  const lsRemote = runGit(['ls-remote', pushUrl, GIT_WRITE_AUTH_PREFLIGHT_REF], authEnv);
  if (lsRemote.status !== 0) {
    const failure = classifyGitRemoteFailure({
      remote,
      operation: 'ls-remote',
      output: lsRemote.stderr || lsRemote.stdout || `git ls-remote exited with code ${lsRemote.status}`,
    });
    return { ok: false, failure };
  }
  if (lsRemote.stdout.trim() !== '') {
    return buildLocalFailure(
      remote,
      'GIT_REMOTE_CONFLICT',
      false,
      `Preflight ref ${GIT_WRITE_AUTH_PREFLIGHT_REF} unexpectedly exists on remote "${remote}"`
    );
  }

  return { ok: true };
}

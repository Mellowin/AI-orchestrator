import { spawnSync } from 'node:child_process';

/**
 * Read the URL of a git remote.
 */
export function getGitRemoteUrl(repoPath: string, remote = 'origin'): string | null {
  const result = spawnSync('git', ['remote', 'get-url', remote], {
    cwd: repoPath,
    shell: false,
    encoding: 'utf-8',
  });
  if (result.status !== 0) {
    return null;
  }
  return result.stdout.trim();
}

/**
 * Inject a GitHub token into an HTTPS GitHub remote URL.
 *
 * GitHub HTTPS authentication uses the `x-access-token` username with the
 * token supplied as the password credential. This format works for classic
 * PATs (`ghp_*`), fine-grained PATs (`github_pat_*`), and GitHub App
 * installation tokens.
 *
 * Returns null for non-GitHub remotes or unparsable URLs.
 *
 * NOTE: kept for compatibility with existing callers/tests. New code must
 * prefer buildEphemeralGitAuthEnv() — a token-bearing URL persists the
 * credential in .git/config when stored via `git remote set-url`.
 */
export function injectGitHubTokenIntoRemoteUrl(remoteUrl: string, token: string): string | null {
  if (!remoteUrl || typeof remoteUrl !== 'string') {
    return null;
  }
  if (!token || typeof token !== 'string') {
    return null;
  }
  try {
    const url = new URL(remoteUrl);
    if (url.hostname.toLowerCase() !== 'github.com') {
      return null;
    }
    url.username = 'x-access-token';
    url.password = token;
    return url.toString();
  } catch {
    return null;
  }
}

/**
 * Return the credential-free form of a git remote URL by stripping any
 * embedded username/password userinfo. Non-URL inputs (e.g. local paths, SCP
 * syntax) are returned unchanged.
 */
export function stripCredentialsFromRemoteUrl(remoteUrl: string): string {
  if (!remoteUrl || typeof remoteUrl !== 'string') {
    return remoteUrl;
  }
  try {
    const url = new URL(remoteUrl);
    if (url.username || url.password) {
      url.username = '';
      url.password = '';
    }
    return url.toString();
  } catch {
    return remoteUrl;
  }
}

/**
 * Ephemeral per-process git authentication for GitHub HTTPS remotes.
 *
 * Returns GIT_CONFIG_* environment variables that inject
 * `http.https://github.com/.extraHeader: Authorization: Bearer <token>` into a
 * single git invocation. The credential exists only in the child process
 * environment: never in argv (process list), never in .git/config, never on
 * disk. The config key is scoped to https://github.com/ so the token is never
 * sent to a different host. Returns {} when no token is configured.
 */
export function buildEphemeralGitAuthEnv(token?: string): Record<string, string> {
  const value = (token ?? process.env.GITHUB_TOKEN)?.trim();
  if (!value) {
    return {};
  }
  return {
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'http.https://github.com/.extraHeader',
    GIT_CONFIG_VALUE_0: `Authorization: Bearer ${value}`,
  };
}

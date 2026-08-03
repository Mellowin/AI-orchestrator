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

function isPersonalAccessToken(token: string): boolean {
  return token.startsWith('ghp_') || token.startsWith('github_pat_');
}

/**
 * Inject a GitHub token into an HTTPS GitHub remote URL.
 *
 * Personal access tokens (`ghp_*` / `github_pat_*`) are placed in the URL
 * username with an empty password, which is the format GitHub requires for
 * HTTPS git operations. Other tokens (e.g. GitHub App installation tokens)
 * keep the `x-access-token` username convention.
 *
 * Returns null for non-GitHub remotes or unparsable URLs.
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
    if (isPersonalAccessToken(token)) {
      url.username = token;
      url.password = '';
    } else {
      url.username = 'x-access-token';
      url.password = token;
    }
    return url.toString();
  } catch {
    return null;
  }
}

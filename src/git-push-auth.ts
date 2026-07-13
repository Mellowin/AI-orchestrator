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
 * Inject a GitHub personal-access token into an HTTPS GitHub remote URL.
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
    url.username = 'x-access-token';
    url.password = token;
    return url.toString();
  } catch {
    return null;
  }
}

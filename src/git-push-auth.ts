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

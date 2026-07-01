import crossSpawn from 'cross-spawn';

export interface PrepareSandboxBaseResult {
  ok: boolean;
  packageLockGenerated: boolean;
  message: string;
}

export function prepareSandboxBase(repoPath: string): PrepareSandboxBaseResult {
  const result = crossSpawn.sync('npm', ['install', '--package-lock-only'], {
    cwd: repoPath,
    encoding: 'utf-8',
    shell: false,
  });

  if (result.status !== 0) {
    return {
      ok: false,
      packageLockGenerated: false,
      message: `npm install --package-lock-only failed: ${result.stderr || result.stdout || 'unknown error'}`,
    };
  }

  return {
    ok: true,
    packageLockGenerated: true,
    message: 'package-lock.json generated',
  };
}

import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';

/**
 * Create a throw-away git repository for the disposable pilot demo.
 * The repository is created under the system temp directory, outside the
 * ai-orchestrator project root.
 *
 * @returns {{ tempDir: string; repoPath: string; remotePath: string; workBranch: string }}
 */
export function createDisposablePilotRepo() {
  const id = `${Date.now()}-${randomBytes(4).toString('hex')}`;
  const tempDir = mkdtempSync(join(tmpdir(), `ai-orchestrator-disposable-pilot-${id}-`));
  const repoPath = join(tempDir, 'repo');
  const remotePath = join(tempDir, 'remote.git');

  mkdirSync(repoPath, { recursive: true });
  mkdirSync(remotePath, { recursive: true });

  writeFileSync(
    join(repoPath, 'README.md'),
    '# Disposable Pilot Demo Repo\n\nThis is a throw-away repo for the AI Orchestrator demo.\n',
    'utf-8'
  );
  writeFileSync(
    join(repoPath, 'metadata.yml'),
    `project: disposable-pilot-demo\ncreated: ${new Date().toISOString()}\n`,
    'utf-8'
  );

  function git(args, cwd = repoPath) {
    const result = spawnSync('git', args, {
      cwd,
      encoding: 'utf-8',
      shell: false,
    });
    if (result.status !== 0) {
      throw new Error(`git ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
    }
    return result;
  }

  git(['init']);
  git(['config', 'user.email', 'demo@example.com']);
  git(['config', 'user.name', 'Demo User']);
  git(['checkout', '-b', 'main']);
  git(['add', '.']);
  git(['commit', '-m', 'init', '--no-gpg-sign']);

  git(['init', '--bare'], remotePath);
  git(['remote', 'add', 'origin', remotePath]);
  git(['push', '-u', 'origin', 'main']);
  git(['checkout', '-b', 'ai-demo-branch']);

  return { tempDir, repoPath, remotePath, workBranch: 'ai-demo-branch' };
}

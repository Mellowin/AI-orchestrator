import { describe, test } from 'node:test';
import assert from 'node:assert';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { getChangedFiles } from '../src/git-manager.js';

function initGitRepo(repoPath: string): void {
  spawnSync('git', ['init'], { cwd: repoPath, encoding: 'utf-8', shell: false });
  spawnSync('git', ['config', 'user.email', 'test@example.com'], {
    cwd: repoPath,
    encoding: 'utf-8',
    shell: false,
  });
  spawnSync('git', ['config', 'user.name', 'Test'], {
    cwd: repoPath,
    encoding: 'utf-8',
    shell: false,
  });
}

function commitAll(repoPath: string, message: string): void {
  spawnSync('git', ['add', '.'], { cwd: repoPath, encoding: 'utf-8', shell: false });
  spawnSync('git', ['commit', '-m', message, '--no-gpg-sign'], {
    cwd: repoPath,
    encoding: 'utf-8',
    shell: false,
  });
}

describe('git-manager', () => {
  test('getChangedFiles preserves filenames with leading status columns', () => {
    const repoPath = join(process.cwd(), 'tmp', `git-manager-test-${Date.now()}`);
    mkdirSync(repoPath, { recursive: true });

    try {
      initGitRepo(repoPath);
      writeFileSync(join(repoPath, 'README.md'), '# Initial\n', 'utf-8');
      commitAll(repoPath, 'init');

      // Modify without staging
      writeFileSync(join(repoPath, 'README.md'), '# Modified\n', 'utf-8');

      // Create untracked file
      mkdirSync(join(repoPath, 'src'), { recursive: true });
      writeFileSync(join(repoPath, 'src', 'new-file.ts'), 'export const x = 1;\n', 'utf-8');

      const changed = getChangedFiles(repoPath);

      assert(changed.includes('README.md'), `Expected README.md in changed files, got: ${JSON.stringify(changed)}`);
      assert(changed.includes('src/new-file.ts'), `Expected src/new-file.ts in changed files, got: ${JSON.stringify(changed)}`);
      assert(!changed.includes('EADME.md'), `Must NOT contain EADME.md (trim bug), got: ${JSON.stringify(changed)}`);
      assert(!changed.includes('EADME.md'), `Must NOT contain EADME.md (trim bug), got: ${JSON.stringify(changed)}`);
    } finally {
      rmSync(repoPath, { recursive: true, force: true });
    }
  });
});

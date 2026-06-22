import { describe, test } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  runGitHealthPreflight,
  formatGitHealthPreflightError,
} from '../src/git-health-preflight.js';

let counter = 0;

function createTempDir(): string {
  const tmpBase = join(process.cwd(), 'tmp');
  if (!existsSync(tmpBase)) {
    mkdirSync(tmpBase);
  }
  return mkdtempSync(join(tmpBase, `git-health-${Date.now()}-${counter++}-`));
}

function initRepo(dir: string): void {
  spawnSync('git', ['init'], { cwd: dir, encoding: 'utf-8', shell: false });
  spawnSync('git', ['config', 'user.email', 'test@example.com'], {
    cwd: dir,
    encoding: 'utf-8',
    shell: false,
  });
  spawnSync('git', ['config', 'user.name', 'Test'], {
    cwd: dir,
    encoding: 'utf-8',
    shell: false,
  });
}

function commitFile(dir: string, filename: string, content: string): void {
  writeFileSync(join(dir, filename), content, 'utf-8');
  spawnSync('git', ['add', filename], { cwd: dir, encoding: 'utf-8', shell: false });
  spawnSync('git', ['commit', '-m', `add ${filename}`, '--no-gpg-sign'], {
    cwd: dir,
    encoding: 'utf-8',
    shell: false,
  });
}

describe('git-health-preflight', () => {
  test('passes on a normal temp repo', () => {
    const repoPath = createTempDir();
    try {
      initRepo(repoPath);
      commitFile(repoPath, 'README.md', '# hello\n');
      spawnSync('git', ['branch', '-m', 'main'], {
        cwd: repoPath,
        encoding: 'utf-8',
        shell: false,
      });
      spawnSync('git', ['checkout', '-b', 'feature'], {
        cwd: repoPath,
        encoding: 'utf-8',
        shell: false,
      });

      const result = runGitHealthPreflight({
        repoPath,
        workBranch: 'feature',
        baseBranch: 'main',
      });
      assert.strictEqual(result.ok, true, `Expected ok, got issues: ${result.issues.join('; ')}`);
      assert.deepStrictEqual(result.issues, []);
    } finally {
      rmSync(repoPath, { recursive: true, force: true });
    }
  });

  test('fails when directory is not a git repo', () => {
    // Use a directory outside the project repo so git does not inherit it.
    const repoPath = mkdtempSync(join(tmpdir(), `git-health-nongit-${Date.now()}-${counter++}-`));
    try {
      const result = runGitHealthPreflight({ repoPath });
      assert.strictEqual(result.ok, false);
      assert(result.issues.some((i) => i.includes('Git repository health check failed')));
    } finally {
      rmSync(repoPath, { recursive: true, force: true });
    }
  });

  test('fails when HEAD is invalid', () => {
    const repoPath = createTempDir();
    try {
      initRepo(repoPath);
      // No commits: HEAD points to an unborn branch and cannot be resolved.
      const result = runGitHealthPreflight({ repoPath });
      assert.strictEqual(result.ok, false);
      assert(result.issues.some((i) => i.includes('HEAD is invalid')));
    } finally {
      rmSync(repoPath, { recursive: true, force: true });
    }
  });

  test('fails when a local branch ref points to zero SHA', () => {
    const repoPath = createTempDir();
    try {
      initRepo(repoPath);
      commitFile(repoPath, 'README.md', '# hello\n');
      spawnSync('git', ['branch', '-m', 'main'], {
        cwd: repoPath,
        encoding: 'utf-8',
        shell: false,
      });
      spawnSync('git', ['checkout', '-b', 'broken'], {
        cwd: repoPath,
        encoding: 'utf-8',
        shell: false,
      });
      spawnSync('git', ['checkout', 'main'], {
        cwd: repoPath,
        encoding: 'utf-8',
        shell: false,
      });
      // Corrupt the broken branch ref directly.
      writeFileSync(
        join(repoPath, '.git', 'refs', 'heads', 'broken'),
        '0000000000000000000000000000000000000000\n',
        'utf-8'
      );

      const result = runGitHealthPreflight({ repoPath });
      assert.strictEqual(result.ok, false);
      assert(result.issues.some((i) => i.includes('zero SHA')));
    } finally {
      rmSync(repoPath, { recursive: true, force: true });
    }
  });

  test('fails when remote base ref points to zero SHA', () => {
    const repoPath = createTempDir();
    try {
      initRepo(repoPath);
      commitFile(repoPath, 'README.md', '# hello\n');
      spawnSync('git', ['branch', '-m', 'main'], {
        cwd: repoPath,
        encoding: 'utf-8',
        shell: false,
      });
      mkdirSync(join(repoPath, '.git', 'refs', 'remotes', 'origin'), { recursive: true });
      writeFileSync(
        join(repoPath, '.git', 'refs', 'remotes', 'origin', 'main'),
        '0000000000000000000000000000000000000000\n',
        'utf-8'
      );

      const result = runGitHealthPreflight({ repoPath, baseBranch: 'main' });
      assert.strictEqual(result.ok, false);
      assert(result.issues.some((i) => i.includes('origin/main')) && result.issues.some((i) => i.includes('zero SHA')));
    } finally {
      rmSync(repoPath, { recursive: true, force: true });
    }
  });

  test('fails when target work branch ref points to zero SHA', () => {
    const repoPath = createTempDir();
    try {
      initRepo(repoPath);
      commitFile(repoPath, 'README.md', '# hello\n');
      spawnSync('git', ['branch', '-m', 'main'], {
        cwd: repoPath,
        encoding: 'utf-8',
        shell: false,
      });
      spawnSync('git', ['checkout', '-b', 'work'], {
        cwd: repoPath,
        encoding: 'utf-8',
        shell: false,
      });
      spawnSync('git', ['checkout', 'main'], {
        cwd: repoPath,
        encoding: 'utf-8',
        shell: false,
      });
      writeFileSync(
        join(repoPath, '.git', 'refs', 'heads', 'work'),
        '0000000000000000000000000000000000000000\n',
        'utf-8'
      );

      const result = runGitHealthPreflight({ repoPath, workBranch: 'work' });
      assert.strictEqual(result.ok, false);
      assert(result.issues.some((i) => i.includes('work')) && result.issues.some((i) => i.includes('zero SHA')));
    } finally {
      rmSync(repoPath, { recursive: true, force: true });
    }
  });

  test('fails when work branch is main', () => {
    const repoPath = createTempDir();
    try {
      initRepo(repoPath);
      commitFile(repoPath, 'README.md', '# hello\n');
      spawnSync('git', ['branch', '-m', 'main'], {
        cwd: repoPath,
        encoding: 'utf-8',
        shell: false,
      });

      const result = runGitHealthPreflight({ repoPath, workBranch: 'main' });
      assert.strictEqual(result.ok, false);
      assert(result.issues.some((i) => i.includes('work_branch is main')));
    } finally {
      rmSync(repoPath, { recursive: true, force: true });
    }
  });

  test('formatGitHealthPreflightError redacts token-like text', () => {
    const issues = [
      'HEAD is invalid: sk-fake-token123 in path',
      'origin/main points to zero SHA',
    ];
    const formatted = formatGitHealthPreflightError(issues);
    assert(formatted.includes('Git repository health check failed'));
    assert(!formatted.includes('sk-fake-token123'));
    assert(formatted.includes('[REDACTED]'));
    assert(formatted.includes('Manual recovery hint'));
  });

  test('error message does not leak token-like text', () => {
    // Directory outside the project repo with a token-like name.
    const repoPath = mkdtempSync(join(tmpdir(), `git-health-secret-${Date.now()}-${counter++}-sk-fake-path-secret`));
    try {
      const result = runGitHealthPreflight({ repoPath });
      assert.strictEqual(result.ok, false);
      const formatted = formatGitHealthPreflightError(result.issues);
      assert(!formatted.includes('sk-fake-path-secret'));
      assert(!formatted.includes('sk-fake'));
    } finally {
      rmSync(repoPath, { recursive: true, force: true });
    }
  });
});

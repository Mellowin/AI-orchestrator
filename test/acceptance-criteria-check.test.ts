import { describe, test } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  runAcceptanceCriteriaChecks,
} from '../src/reviewer/acceptance-criteria-check.js';

function createTempRepo(): string {
  const tmpBase = join(process.cwd(), 'tmp');
  if (!existsSync(tmpBase)) {
    mkdirSync(tmpBase);
  }
  const repoPath = mkdtempSync(join(tmpBase, 'acceptance-check-'));
  spawnSync('git', ['init'], { cwd: repoPath, encoding: 'utf-8', shell: false });
  spawnSync('git', ['config', 'user.email', 'test@test.com'], {
    cwd: repoPath,
    encoding: 'utf-8',
    shell: false,
  });
  spawnSync('git', ['config', 'user.name', 'Test'], {
    cwd: repoPath,
    encoding: 'utf-8',
    shell: false,
  });
  writeFileSync(join(repoPath, 'README.md'), '# hello\n', 'utf-8');
  spawnSync('git', ['add', '.'], { cwd: repoPath, encoding: 'utf-8', shell: false });
  spawnSync('git', ['commit', '-m', 'init', '--no-gpg-sign'], {
    cwd: repoPath,
    encoding: 'utf-8',
    shell: false,
  });
  return repoPath;
}

function cleanupRepo(repoPath: string): void {
  rmSync(repoPath, { recursive: true, force: true });
}

function getCommitSha(repoPath: string): string {
  const result = spawnSync('git', ['log', '-1', '--format=%H'], {
    cwd: repoPath,
    encoding: 'utf-8',
    shell: false,
  });
  return result.stdout.trim();
}

function addCommitFile(repoPath: string, path: string, content: string): void {
  const fullPath = join(repoPath, path);
  const dir = join(fullPath, '..');
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(fullPath, content, 'utf-8');
  spawnSync('git', ['add', path], { cwd: repoPath, encoding: 'utf-8', shell: false });
  spawnSync('git', ['commit', '-m', `add ${path}`, '--no-gpg-sign'], {
    cwd: repoPath,
    encoding: 'utf-8',
    shell: false,
  });
}

describe('runAcceptanceCriteriaChecks', () => {
  test('returns no issues when criteria are empty', () => {
    const repoPath = createTempRepo();
    try {
      const commitSha = getCommitSha(repoPath);
      const issues = runAcceptanceCriteriaChecks({
        repoPath,
        commitSha,
        acceptanceCriteria: [],
        allowedFiles: ['README.md'],
      });
      assert.deepStrictEqual(issues, []);
    } finally {
      cleanupRepo(repoPath);
    }
  });

  test('passes when file contains the exact string', () => {
    const repoPath = createTempRepo();
    try {
      const commitSha = getCommitSha(repoPath);
      const issues = runAcceptanceCriteriaChecks({
        repoPath,
        commitSha,
        acceptanceCriteria: [
          'The file README.md must contain the exact string: "hello"',
        ],
        allowedFiles: ['README.md'],
      });
      assert.deepStrictEqual(issues, []);
    } finally {
      cleanupRepo(repoPath);
    }
  });

  test('fails when file does not contain the exact string', () => {
    const repoPath = createTempRepo();
    try {
      const commitSha = getCommitSha(repoPath);
      const issues = runAcceptanceCriteriaChecks({
        repoPath,
        commitSha,
        acceptanceCriteria: [
          `The file README.md must contain the exact string: 'missing'`,
        ],
        allowedFiles: ['README.md'],
      });
      assert.strictEqual(issues.length, 1);
      assert(issues[0].detail.includes('does not contain the exact string'));
      assert(issues[0].detail.includes('missing'));
      assert.strictEqual(issues[0].targetPath, 'README.md');
    } finally {
      cleanupRepo(repoPath);
    }
  });

  test('checks the single concrete allowed file when path is not in criterion', () => {
    const repoPath = createTempRepo();
    try {
      addCommitFile(repoPath, 'docs/part3.md', 'Concluding sentence for PART2: The chain continues.\n');
      const commitSha = getCommitSha(repoPath);
      const issues = runAcceptanceCriteriaChecks({
        repoPath,
        commitSha,
        acceptanceCriteria: [
          `The file must contain the exact string: 'Concluding sentence for PART2: The chain continues.'`,
        ],
        allowedFiles: ['docs/part3.md'],
      });
      assert.deepStrictEqual(issues, []);
    } finally {
      cleanupRepo(repoPath);
    }
  });

  test('fails when file does not end with the exact sentence', () => {
    const repoPath = createTempRepo();
    try {
      addCommitFile(
        repoPath,
        'docs/part2.md',
        'Some content\nNot the expected ending\n'
      );
      const commitSha = getCommitSha(repoPath);
      const issues = runAcceptanceCriteriaChecks({
        repoPath,
        commitSha,
        acceptanceCriteria: [
          `The file docs/part2.md must end with the exact sentence: "Expected ending."`,
        ],
        allowedFiles: ['docs/part2.md'],
      });
      assert.strictEqual(issues.length, 1);
      assert(issues[0].detail.includes('does not end with the exact sentence'));
    } finally {
      cleanupRepo(repoPath);
    }
  });

  test('passes when file ends with the exact sentence ignoring trailing whitespace', () => {
    const repoPath = createTempRepo();
    try {
      addCommitFile(
        repoPath,
        'docs/part2.md',
        'Some content\nExpected ending.\n\n'
      );
      const commitSha = getCommitSha(repoPath);
      const issues = runAcceptanceCriteriaChecks({
        repoPath,
        commitSha,
        acceptanceCriteria: [
          `The file docs/part2.md must end with the exact sentence: 'Expected ending.'`,
        ],
        allowedFiles: ['docs/part2.md'],
      });
      assert.deepStrictEqual(issues, []);
    } finally {
      cleanupRepo(repoPath);
    }
  });

  test('passes when file starts with the exact string', () => {
    const repoPath = createTempRepo();
    try {
      addCommitFile(repoPath, 'docs/part1.md', 'Introduction line\nMore text\n');
      const commitSha = getCommitSha(repoPath);
      const issues = runAcceptanceCriteriaChecks({
        repoPath,
        commitSha,
        acceptanceCriteria: [
          `The file docs/part1.md must start with the exact string: "Introduction line"`,
        ],
        allowedFiles: ['docs/part1.md'],
      });
      assert.deepStrictEqual(issues, []);
    } finally {
      cleanupRepo(repoPath);
    }
  });

  test('fails when target file is not in commit', () => {
    const repoPath = createTempRepo();
    try {
      const commitSha = getCommitSha(repoPath);
      const issues = runAcceptanceCriteriaChecks({
        repoPath,
        commitSha,
        acceptanceCriteria: [
          `The file missing.md must contain the exact string: "x"`,
        ],
        allowedFiles: ['missing.md'],
      });
      assert.strictEqual(issues.length, 1);
      assert(issues[0].detail.includes('Could not read missing.md'));
    } finally {
      cleanupRepo(repoPath);
    }
  });

  test('fails when target path cannot be resolved', () => {
    const repoPath = createTempRepo();
    try {
      const commitSha = getCommitSha(repoPath);
      const issues = runAcceptanceCriteriaChecks({
        repoPath,
        commitSha,
        acceptanceCriteria: [
          `The file must contain the exact string: "x"`,
        ],
        allowedFiles: [],
      });
      assert.strictEqual(issues.length, 1);
      assert(issues[0].detail.includes('Cannot determine target file'));
    } finally {
      cleanupRepo(repoPath);
    }
  });

  test('ignores criteria that do not match a deterministic pattern', () => {
    const repoPath = createTempRepo();
    try {
      const commitSha = getCommitSha(repoPath);
      const issues = runAcceptanceCriteriaChecks({
        repoPath,
        commitSha,
        acceptanceCriteria: [
          'The code should be well written',
          'No undefined behavior',
        ],
        allowedFiles: ['README.md'],
      });
      assert.deepStrictEqual(issues, []);
    } finally {
      cleanupRepo(repoPath);
    }
  });

  test('reports multiple independent failures', () => {
    const repoPath = createTempRepo();
    try {
      addCommitFile(repoPath, 'docs/part2.md', 'Wrong content\n');
      addCommitFile(repoPath, 'docs/part3.md', 'Also wrong\n');
      const commitSha = getCommitSha(repoPath);
      const issues = runAcceptanceCriteriaChecks({
        repoPath,
        commitSha,
        acceptanceCriteria: [
          `docs/part2.md must end with the exact sentence: "Expected ending."`,
          `docs/part3.md must contain the exact string: "expected string"`,
        ],
        allowedFiles: ['docs/part2.md', 'docs/part3.md'],
      });
      assert.strictEqual(issues.length, 2);
      assert(issues.some((i) => i.targetPath === 'docs/part2.md'));
      assert(issues.some((i) => i.targetPath === 'docs/part3.md'));
    } finally {
      cleanupRepo(repoPath);
    }
  });
});

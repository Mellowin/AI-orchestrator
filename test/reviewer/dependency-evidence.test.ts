import { describe, test } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  buildDependencyEvidence,
  buildMissionDependencyEvidence,
} from '../../src/reviewer/dependency-evidence.js';
import { buildReviewerPrompt } from '../../src/reviewer/reviewer-prompt.js';
import { runSummaryChecks } from '../../src/reviewer/summary-checks.js';
import type { DependencyEvidencePackage } from '../../src/types.js';

function createTempRepo(): string {
  const tmpBase = join(process.cwd(), 'tmp');
  if (!existsSync(tmpBase)) {
    mkdirSync(tmpBase);
  }
  const repoPath = mkdtempSync(join(tmpBase, 'dep-evidence-'));
  spawnSync('git', ['init'], { cwd: repoPath, encoding: 'utf-8', shell: false });
  spawnSync('git', ['config', 'user.email', 'test@test.com'], { cwd: repoPath, encoding: 'utf-8', shell: false });
  spawnSync('git', ['config', 'user.name', 'Test'], { cwd: repoPath, encoding: 'utf-8', shell: false });
  writeFileSync(join(repoPath, 'README.md'), '# init\n', 'utf-8');
  spawnSync('git', ['add', '.'], { cwd: repoPath, encoding: 'utf-8', shell: false });
  spawnSync('git', ['commit', '-m', 'init', '--no-gpg-sign'], { cwd: repoPath, encoding: 'utf-8', shell: false });
  return repoPath;
}

function commitFile(repoPath: string, path: string, content: string, message: string): string {
  const fullPath = join(repoPath, path);
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, content, 'utf-8');
  spawnSync('git', ['add', path], { cwd: repoPath, encoding: 'utf-8', shell: false });
  const result = spawnSync('git', ['commit', '-m', message, '--no-gpg-sign'], {
    cwd: repoPath,
    encoding: 'utf-8',
    shell: false,
  });
  if (result.status !== 0) {
    throw new Error(`commit failed: ${result.stderr}`);
  }
  const shaResult = spawnSync('git', ['log', '-1', '--format=%H'], { cwd: repoPath, encoding: 'utf-8', shell: false });
  return shaResult.stdout.trim();
}

function getSha(repoPath: string): string {
  const result = spawnSync('git', ['log', '-1', '--format=%H'], { cwd: repoPath, encoding: 'utf-8', shell: false });
  return result.stdout.trim();
}

describe('dependency-evidence builder', () => {
  test('includes accepted ancestor file contents', () => {
    const repoPath = createTempRepo();
    const part1Sha = commitFile(repoPath, 'docs/proofs/PART1.md', 'part1 content\n', 'part1');

    const evidence = buildDependencyEvidence({
      repoPath,
      currentTaskId: 'part2',
      tasks: [
        { id: 'part1', allowed_files: ['docs/proofs/PART1.md'] },
        { id: 'part2', allowed_files: ['docs/proofs/PART2.md'], depends_on: ['part1'] },
      ],
      taskStates: [
        { task_id: 'part1', status: 'accepted', commit_sha: part1Sha },
      ],
    });

    assert.strictEqual(evidence.items.length, 1);
    assert.strictEqual(evidence.items[0].task_id, 'part1');
    assert.strictEqual(evidence.items[0].path, 'docs/proofs/PART1.md');
    assert.strictEqual(evidence.items[0].content, 'part1 content\n');
    assert.strictEqual(evidence.items[0].bytes, 14);
    assert.strictEqual(evidence.items[0].lines, 1);
    assert.ok(evidence.items[0].content_sha256.length > 0);
  });

  test('includes transitive ancestors', () => {
    const repoPath = createTempRepo();
    const part1Sha = commitFile(repoPath, 'docs/proofs/PART1.md', 'p1\n', 'p1');
    const part2Sha = commitFile(repoPath, 'docs/proofs/PART2.md', 'p2\n', 'p2');

    const evidence = buildDependencyEvidence({
      repoPath,
      currentTaskId: 'part3',
      tasks: [
        { id: 'part1', allowed_files: ['docs/proofs/PART1.md'] },
        { id: 'part2', allowed_files: ['docs/proofs/PART2.md'], depends_on: ['part1'] },
        { id: 'part3', allowed_files: ['docs/proofs/PART3.md'], depends_on: ['part2'] },
      ],
      taskStates: [
        { task_id: 'part1', status: 'accepted', commit_sha: part1Sha },
        { task_id: 'part2', status: 'accepted', commit_sha: part2Sha },
      ],
    });

    const paths = evidence.items.map((i) => i.path).sort();
    assert.deepStrictEqual(paths, ['docs/proofs/PART1.md', 'docs/proofs/PART2.md']);
  });

  test('excludes unrelated tasks', () => {
    const repoPath = createTempRepo();
    const part1Sha = commitFile(repoPath, 'docs/proofs/PART1.md', 'p1\n', 'p1');
    const otherSha = commitFile(repoPath, 'docs/other.md', 'other\n', 'other');

    const evidence = buildDependencyEvidence({
      repoPath,
      currentTaskId: 'part2',
      tasks: [
        { id: 'part1', allowed_files: ['docs/proofs/PART1.md'] },
        { id: 'other', allowed_files: ['docs/other.md'] },
        { id: 'part2', allowed_files: ['docs/proofs/PART2.md'], depends_on: ['part1'] },
      ],
      taskStates: [
        { task_id: 'part1', status: 'accepted', commit_sha: part1Sha },
        { task_id: 'other', status: 'accepted', commit_sha: otherSha },
      ],
    });

    const paths = evidence.items.map((i) => i.path);
    assert.deepStrictEqual(paths, ['docs/proofs/PART1.md']);
  });

  test('throws when ancestor is not accepted', () => {
    const repoPath = createTempRepo();
    const part1Sha = commitFile(repoPath, 'docs/proofs/PART1.md', 'p1\n', 'p1');

    assert.throws(
      () =>
        buildDependencyEvidence({
          repoPath,
          currentTaskId: 'part2',
          tasks: [
            { id: 'part1', allowed_files: ['docs/proofs/PART1.md'] },
            { id: 'part2', allowed_files: ['docs/proofs/PART2.md'], depends_on: ['part1'] },
          ],
          taskStates: [{ task_id: 'part1', status: 'failed', commit_sha: part1Sha }],
        }),
      /ancestor task part1 is failed/
    );
  });

  test('throws when ancestor commit is not in current branch history', () => {
    const repoPath = createTempRepo();
    commitFile(repoPath, 'docs/proofs/PART1.md', 'p1\n', 'p1');
    // Create a separate orphan commit by committing and then resetting to init
    const initSha = getSha(repoPath);
    spawnSync('git', ['checkout', '--orphan', 'orphan'], { cwd: repoPath, encoding: 'utf-8', shell: false });
    spawnSync('git', ['rm', '-rf', '.'], { cwd: repoPath, encoding: 'utf-8', shell: false });
    writeFileSync(join(repoPath, 'orphan.md'), 'o\n', 'utf-8');
    spawnSync('git', ['add', '.'], { cwd: repoPath, encoding: 'utf-8', shell: false });
    spawnSync('git', ['commit', '-m', 'orphan', '--no-gpg-sign'], { cwd: repoPath, encoding: 'utf-8', shell: false });
    const orphanSha = getSha(repoPath);

    // Go back to main branch
    spawnSync('git', ['checkout', 'main'], { cwd: repoPath, encoding: 'utf-8', shell: false });

    assert.throws(
      () =>
        buildDependencyEvidence({
          repoPath,
          currentTaskId: 'part2',
          tasks: [
            { id: 'part1', allowed_files: ['docs/proofs/PART1.md'] },
            { id: 'part2', allowed_files: ['docs/proofs/PART2.md'], depends_on: ['part1'] },
          ],
          taskStates: [
            { task_id: 'part1', status: 'accepted', commit_sha: orphanSha },
          ],
        }),
      /not in current branch history/
    );
    // Use initSha to avoid unused variable lint
    assert.ok(initSha.length === 40);
  });

  test('excludes sensitive and binary files', () => {
    const repoPath = createTempRepo();
    const sha = commitFile(repoPath, '.env', 'SECRET=1\n', 'add env');
    // Binary file with null byte
    const binPath = join(repoPath, 'bin.dat');
    writeFileSync(binPath, Buffer.from([0x00, 0x01, 0x02]));
    spawnSync('git', ['add', 'bin.dat'], { cwd: repoPath, encoding: 'utf-8', shell: false });
    spawnSync('git', ['commit', '-m', 'binary', '--no-gpg-sign'], { cwd: repoPath, encoding: 'utf-8', shell: false });
    const binSha = getSha(repoPath);

    const evidence = buildMissionDependencyEvidence({
      repoPath,
      tasks: [
        { id: 'bad1', allowed_files: ['.env'] },
        { id: 'bad2', allowed_files: ['bin.dat'] },
      ],
      taskStates: [
        { task_id: 'bad1', status: 'accepted', commit_sha: sha },
        { task_id: 'bad2', status: 'accepted', commit_sha: binSha },
      ],
    });

    assert.strictEqual(evidence.items.length, 0);
  });

  test('truncates per-file and total content', () => {
    const repoPath = createTempRepo();
    const sha = commitFile(repoPath, 'docs/big.md', 'x'.repeat(200), 'big');

    const evidence = buildMissionDependencyEvidence({
      repoPath,
      tasks: [{ id: 'big', allowed_files: ['docs/big.md'] }],
      taskStates: [{ task_id: 'big', status: 'accepted', commit_sha: sha }],
      perFileByteLimit: 50,
      totalByteLimit: 1000,
    });

    assert.strictEqual(evidence.items.length, 1);
    assert.ok(evidence.items[0].truncated);
    assert.ok(evidence.items[0].content.includes('[truncated'));
    assert.strictEqual(evidence.items[0].bytes, 200);
    // The content string is truncated, but original bytes metadata is preserved.
    assert.ok(evidence.items[0].content.length < 200);
  });

  test('mission evidence includes all accepted tasks', () => {
    const repoPath = createTempRepo();
    const sha1 = commitFile(repoPath, 'docs/p1.md', 'one\n', 'p1');
    const sha2 = commitFile(repoPath, 'docs/p2.md', 'two\n', 'p2');

    const evidence = buildMissionDependencyEvidence({
      repoPath,
      tasks: [
        { id: 'p1', allowed_files: ['docs/p1.md'] },
        { id: 'p2', allowed_files: ['docs/p2.md'] },
      ],
      taskStates: [
        { task_id: 'p1', status: 'accepted', commit_sha: sha1 },
        { task_id: 'p2', status: 'accepted', commit_sha: sha2 },
      ],
    });

    const paths = evidence.items.map((i) => i.path).sort();
    assert.deepStrictEqual(paths, ['docs/p1.md', 'docs/p2.md']);
    assert.ok(evidence.total_bytes > 0);
  });
});

describe('dependency evidence in reviewer prompt', () => {
  test('includes dependency evidence section when provided', () => {
    const evidence: DependencyEvidencePackage = {
      items: [
        {
          task_id: 'part1',
          task_status: 'accepted',
          path: 'docs/proofs/PART1.md',
          content_sha256: 'abc123',
          bytes: 14,
          lines: 1,
          content: 'part1 content\n',
        },
      ],
      total_bytes: 14,
      truncated: false,
      omitted_count: 0,
    };

    const prompt = buildReviewerPrompt({
      block_id: undefined,
      repo_path: '/tmp/repo',
      task_id: 'part2',
      task_title: 'Part 2',
      task_goal: 'Create part2 referencing part1',
      allowed_files: ['docs/proofs/PART2.md'],
      denied_files: ['.env'],
      max_lines_changed: 50,
      commit_sha: 'a'.repeat(40),
      changed_files: ['docs/proofs/PART2.md'],
      diff: '+summary\n',
      typecheck_result: 'pass',
      build_result: 'pass',
      test_result: 'pass',
      git_status: '',
      safety_findings: [],
      dependency_evidence: evidence,
    });

    assert.ok(prompt.includes('## Dependency Evidence (read-only context from accepted ancestor tasks)'));
    assert.ok(prompt.includes('docs/proofs/PART1.md'));
    assert.ok(prompt.includes('part1 content'));
    assert.ok(prompt.includes('Do NOT request changes to dependency files'));
    assert.ok(prompt.includes('current task scope is the only writable scope'));
  });
});

describe('summary checks', () => {
  test('detects missing reference to dependency artifact', () => {
    const repoPath = createTempRepo();
    const sha = commitFile(repoPath, 'docs/proofs/PART2.md', 'no references here\n', 'part2');

    const result = runSummaryChecks({
      repoPath,
      commitSha: sha,
      allowedFiles: ['docs/proofs/PART2.md'],
      acceptanceCriteria: ['must reference docs/proofs/PART1.md'],
      dependencyEvidence: {
        items: [
          {
            task_id: 'part1',
            task_status: 'accepted',
            path: 'docs/proofs/PART1.md',
            content_sha256: 'abc',
            bytes: 10,
            lines: 1,
            content: 'part1 content\n',
          },
        ],
        total_bytes: 10,
        truncated: false,
        omitted_count: 0,
      },
    });

    assert.strictEqual(result.ok, false);
    assert.ok(result.issues.some((i) => i.includes('docs/proofs/PART1.md')));
  });

  test('passes when dependency artifact is referenced', () => {
    const repoPath = createTempRepo();
    const sha = commitFile(repoPath, 'docs/proofs/PART2.md', 'See docs/proofs/PART1.md for details.\n', 'part2');

    const result = runSummaryChecks({
      repoPath,
      commitSha: sha,
      allowedFiles: ['docs/proofs/PART2.md'],
      acceptanceCriteria: ['must reference docs/proofs/PART1.md'],
      dependencyEvidence: {
        items: [
          {
            task_id: 'part1',
            task_status: 'accepted',
            path: 'docs/proofs/PART1.md',
            content_sha256: 'abc',
            bytes: 10,
            lines: 1,
            content: 'part1 content\n',
          },
        ],
        total_bytes: 10,
        truncated: false,
        omitted_count: 0,
      },
    });

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.issues.length, 0);
  });

  test('detects fabricated dependency path', () => {
    const repoPath = createTempRepo();
    const sha = commitFile(repoPath, 'docs/proofs/PART2.md', 'See docs/proofs/PART99.md\n', 'part2');

    const result = runSummaryChecks({
      repoPath,
      commitSha: sha,
      allowedFiles: ['docs/proofs/PART2.md'],
      acceptanceCriteria: ['must summarize part1'],
      dependencyEvidence: {
        items: [
          {
            task_id: 'part1',
            task_status: 'accepted',
            path: 'docs/proofs/PART1.md',
            content_sha256: 'abc',
            bytes: 10,
            lines: 1,
            content: 'part1 content\n',
          },
        ],
        total_bytes: 10,
        truncated: false,
        omitted_count: 0,
      },
    });

    assert.strictEqual(result.ok, false);
    assert.ok(result.issues.some((i) => i.includes('PART99.md')));
  });
});

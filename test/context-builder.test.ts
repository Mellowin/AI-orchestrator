import { describe, test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildContext } from '../src/context-builder.js';
import type { Task } from '../src/types.js';

function makeTask(overrides?: Partial<Task>): Task {
  return {
    id: 'demo-task',
    title: 'Demo Task',
    goal: 'Make it work',
    repo_path: '/tmp/fake-repo',
    base_branch: 'main',
    work_branch: 'ai/demo-task',
    context_files: [],
    checks: [],
    guardrails: {
      deny_modify: ['.env'],
      auto_commit: false,
      auto_push: false,
      auto_merge: false,
    },
    ...overrides,
  };
}

describe('context-builder', () => {
  test('buildContext reads context files and returns contents', () => {
    const repo = mkdtempSync(join(tmpdir(), 'ctx-repo-'));
    try {
      writeFileSync(join(repo, 'a.txt'), 'content A', 'utf-8');
      writeFileSync(join(repo, 'b.txt'), 'content B', 'utf-8');

      const task = makeTask({
        repo_path: repo,
        context_files: ['a.txt', 'b.txt'],
      });

      const ctx = buildContext(task);
      assert.strictEqual(ctx.files.length, 2);
      assert.strictEqual(ctx.files[0].path, 'a.txt');
      assert.strictEqual(ctx.files[0].content, 'content A');
      assert.strictEqual(ctx.files[1].path, 'b.txt');
      assert.strictEqual(ctx.files[1].content, 'content B');
    } finally {
      rmSync(repo, { recursive: true });
    }
  });

  test('buildContext preserves deterministic order', () => {
    const repo = mkdtempSync(join(tmpdir(), 'ctx-repo-'));
    try {
      writeFileSync(join(repo, 'z.txt'), 'Z', 'utf-8');
      writeFileSync(join(repo, 'a.txt'), 'A', 'utf-8');
      writeFileSync(join(repo, 'm.txt'), 'M', 'utf-8');

      const task = makeTask({
        repo_path: repo,
        context_files: ['z.txt', 'a.txt', 'm.txt'],
      });

      const ctx1 = buildContext(task);
      const ctx2 = buildContext(task);
      assert.deepStrictEqual(ctx1.files, ctx2.files);
      assert.strictEqual(ctx1.files[0].path, 'z.txt');
      assert.strictEqual(ctx1.files[1].path, 'a.txt');
      assert.strictEqual(ctx1.files[2].path, 'm.txt');
    } finally {
      rmSync(repo, { recursive: true });
    }
  });

  test('buildContext throws when context file does not exist', () => {
    const repo = mkdtempSync(join(tmpdir(), 'ctx-repo-'));
    try {
      const task = makeTask({
        repo_path: repo,
        context_files: ['missing.txt'],
      });

      assert.throws(() => buildContext(task), /context_file does not exist: missing.txt/);
    } finally {
      rmSync(repo, { recursive: true });
    }
  });

  test('buildContext throws when context file is a directory', () => {
    const repo = mkdtempSync(join(tmpdir(), 'ctx-repo-'));
    try {
      mkdirSync(join(repo, 'subdir'));
      const task = makeTask({
        repo_path: repo,
        context_files: ['subdir'],
      });

      assert.throws(() => buildContext(task), /context_file is a directory: subdir/);
    } finally {
      rmSync(repo, { recursive: true });
    }
  });

  test('buildContext rejects absolute context file paths', () => {
    const repo = mkdtempSync(join(tmpdir(), 'ctx-repo-'));
    try {
      const task = makeTask({
        repo_path: repo,
        context_files: ['/etc/passwd'],
      });

      assert.throws(() => buildContext(task), /Absolute paths are not allowed/);
    } finally {
      rmSync(repo, { recursive: true });
    }
  });

  test('buildContext rejects path traversal', () => {
    const repo = mkdtempSync(join(tmpdir(), 'ctx-repo-'));
    try {
      const task = makeTask({
        repo_path: repo,
        context_files: ['../secret.txt'],
      });

      assert.throws(() => buildContext(task), /Path traversal detected/);
    } finally {
      rmSync(repo, { recursive: true });
    }
  });

  test('buildContext handles empty context_files', () => {
    const repo = mkdtempSync(join(tmpdir(), 'ctx-repo-'));
    try {
      const task = makeTask({
        repo_path: repo,
        context_files: [],
      });

      const ctx = buildContext(task);
      assert.deepStrictEqual(ctx.files, []);
    } finally {
      rmSync(repo, { recursive: true });
    }
  });

  test('buildContext includes task metadata', () => {
    const repo = mkdtempSync(join(tmpdir(), 'ctx-repo-'));
    try {
      writeFileSync(join(repo, 'x.txt'), 'X', 'utf-8');
      const task = makeTask({
        id: 'task-42',
        title: 'Fix bug',
        goal: 'Fix the critical bug',
        repo_path: repo,
        context_files: ['x.txt'],
      });

      const ctx = buildContext(task);
      assert.strictEqual(ctx.task_summary, 'task-42: Fix bug');
      assert.strictEqual(ctx.goal, 'Fix the critical bug');
      assert.ok(Array.isArray(ctx.constraints));
      assert.ok(ctx.constraints.length > 0);
      assert.ok(ctx.constraints.some((c) => c.includes('guardrails.deny_modify')));
      assert.ok(ctx.constraints.some((c) => c.includes('push, merge')));
    } finally {
      rmSync(repo, { recursive: true });
    }
  });

  test('buildContext does not escape repo via relative resolution', () => {
    const repo = mkdtempSync(join(tmpdir(), 'ctx-repo-'));
    try {
      const task = makeTask({
        repo_path: repo,
        context_files: ['a/../../outside.txt'],
      });

      assert.throws(
        () => buildContext(task),
        /Path traversal detected|context_file escapes repo_path/
      );
    } finally {
      rmSync(repo, { recursive: true });
    }
  });

  test('buildContext includes max_lines_changed constraint and field when set', () => {
    const repo = mkdtempSync(join(tmpdir(), 'ctx-repo-'));
    try {
      writeFileSync(join(repo, 'x.txt'), 'X', 'utf-8');
      const task = makeTask({
        repo_path: repo,
        context_files: ['x.txt'],
        guardrails: {
          deny_modify: ['.env'],
          auto_commit: false,
          auto_push: false,
          auto_merge: false,
          max_lines_changed: 25,
        },
      });

      const ctx = buildContext(task);
      assert.strictEqual(ctx.max_lines_changed, 25);
      const constraint = ctx.constraints.find((c) => c.includes('HARD LIMIT'));
      assert.ok(constraint, 'expected HARD LIMIT constraint');
      assert.ok(constraint.includes('25'), 'constraint must include the limit value');
      assert.ok(constraint.includes('newly created file'), 'constraint must mention new files');
    } finally {
      rmSync(repo, { recursive: true });
    }
  });

  test('buildContext leaves max_lines_changed undefined when not set', () => {
    const repo = mkdtempSync(join(tmpdir(), 'ctx-repo-'));
    try {
      writeFileSync(join(repo, 'x.txt'), 'X', 'utf-8');
      const task = makeTask({
        repo_path: repo,
        context_files: ['x.txt'],
      });

      const ctx = buildContext(task);
      assert.strictEqual(ctx.max_lines_changed, undefined);
      assert.ok(!ctx.constraints.some((c) => c.includes('HARD LIMIT')));
    } finally {
      rmSync(repo, { recursive: true });
    }
  });
});

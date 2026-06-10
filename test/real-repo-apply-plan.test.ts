import { describe, test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildRealRepoApplyPlan,
  type RealRepoApplyPlanInput,
} from '../src/real-repo-apply-plan.js';

function makeInput(
  overrides: Partial<RealRepoApplyPlanInput> = {}
): RealRepoApplyPlanInput {
  return {
    taskId: 'test-task',
    attempt: 1,
    existingPaths: ['README.md'],
    files: [{ path: 'src/new.ts', content: 'export const x = 1;\n' }],
    ...overrides,
  };
}

describe('buildRealRepoApplyPlan', () => {
  test('builds create plan for new file', () => {
    const result = buildRealRepoApplyPlan(
      makeInput({ existingPaths: [], files: [{ path: 'new.ts', content: 'a' }] })
    );
    assert.strictEqual(result.ok, true);
    if (!result.ok) return;
    assert.strictEqual(result.files.length, 1);
    assert.strictEqual(result.files[0].action, 'create');
    assert.strictEqual(result.files[0].path, 'new.ts');
  });

  test('builds overwrite plan for existing file', () => {
    const result = buildRealRepoApplyPlan(
      makeInput({
        existingPaths: ['old.ts'],
        files: [{ path: 'old.ts', content: 'b' }],
      })
    );
    assert.strictEqual(result.ok, true);
    if (!result.ok) return;
    assert.strictEqual(result.files[0].action, 'overwrite');
  });

  test('preserves file order', () => {
    const result = buildRealRepoApplyPlan(
      makeInput({
        existingPaths: [],
        files: [
          { path: 'a.ts', content: '1' },
          { path: 'b.ts', content: '2' },
          { path: 'c.ts', content: '3' },
        ],
      })
    );
    assert.strictEqual(result.ok, true);
    if (!result.ok) return;
    assert.deepStrictEqual(result.files.map((f) => f.path), ['a.ts', 'b.ts', 'c.ts']);
  });

  test('trims taskId and paths', () => {
    const result = buildRealRepoApplyPlan(
      makeInput({
        taskId: '  task-1  ',
        existingPaths: ['  README.md  '],
        files: [{ path: '  src/x.ts  ', content: 'x' }],
      })
    );
    assert.strictEqual(result.ok, true);
    if (!result.ok) return;
    assert.strictEqual(result.taskId, 'task-1');
    assert.strictEqual(result.files[0].path, 'src/x.ts');
    assert.strictEqual(result.files[0].backupPath, 'runs/task-1/attempt-1/files-before/src/x.ts');
  });

  test('builds correct runDir', () => {
    const result = buildRealRepoApplyPlan(
      makeInput({ taskId: 'my-task', attempt: 3 })
    );
    assert.strictEqual(result.ok, true);
    if (!result.ok) return;
    assert.strictEqual(result.runDir, 'runs/my-task/attempt-3');
  });

  test('builds correct backupPath', () => {
    const result = buildRealRepoApplyPlan(
      makeInput({ taskId: 't', attempt: 2, files: [{ path: 'a/b.ts', content: 'c' }] })
    );
    assert.strictEqual(result.ok, true);
    if (!result.ok) return;
    assert.strictEqual(result.files[0].backupPath, 'runs/t/attempt-2/files-before/a/b.ts');
  });

  test('allows empty string content', () => {
    const result = buildRealRepoApplyPlan(
      makeInput({ files: [{ path: 'empty.ts', content: '' }] })
    );
    assert.strictEqual(result.ok, true);
    if (!result.ok) return;
    assert.strictEqual(result.files[0].content, '');
  });

  test('rejects empty taskId', () => {
    const result = buildRealRepoApplyPlan(makeInput({ taskId: '' }));
    assert.strictEqual(result.ok, false);
    if (result.ok) return;
    assert(result.reason.includes('taskId'));
  });

  test('rejects non-positive attempt', () => {
    const result = buildRealRepoApplyPlan(makeInput({ attempt: 0 }));
    assert.strictEqual(result.ok, false);
    if (result.ok) return;
    assert(result.reason.includes('attempt'));
  });

  test('rejects non-integer attempt', () => {
    const result = buildRealRepoApplyPlan(makeInput({ attempt: 1.5 }));
    assert.strictEqual(result.ok, false);
    if (result.ok) return;
    assert(result.reason.includes('attempt'));
  });

  test('rejects empty file path', () => {
    const result = buildRealRepoApplyPlan(makeInput({ files: [{ path: '', content: 'x' }] }));
    assert.strictEqual(result.ok, false);
    if (result.ok) return;
    assert(result.reason.includes('empty'));
  });

  test('rejects duplicate file paths after trimming', () => {
    const result = buildRealRepoApplyPlan(
      makeInput({
        files: [
          { path: 'a.ts', content: '1' },
          { path: '  a.ts  ', content: '2' },
        ],
      })
    );
    assert.strictEqual(result.ok, false);
    if (result.ok) return;
    assert(result.reason.includes('Duplicate file path'));
  });

  test('rejects absolute paths', () => {
    const result = buildRealRepoApplyPlan(
      makeInput({ files: [{ path: '/etc/passwd', content: 'x' }] })
    );
    assert.strictEqual(result.ok, false);
    if (result.ok) return;
    assert(result.reason.includes('absolute'));
  });

  test('rejects Windows absolute path C:/temp/file.ts', () => {
    const result = buildRealRepoApplyPlan(
      makeInput({ files: [{ path: 'C:/temp/file.ts', content: 'x' }] })
    );
    assert.strictEqual(result.ok, false);
    if (result.ok) return;
    assert(result.reason.includes('absolute'));
  });

  test('rejects Windows absolute path c:/Users/test/file.ts', () => {
    const result = buildRealRepoApplyPlan(
      makeInput({ files: [{ path: 'c:/Users/test/file.ts', content: 'x' }] })
    );
    assert.strictEqual(result.ok, false);
    if (result.ok) return;
    assert(result.reason.includes('absolute'));
  });

  test('rejects Windows absolute path inside existingPaths', () => {
    const result = buildRealRepoApplyPlan(
      makeInput({ existingPaths: ['D:/repo/file.ts'] })
    );
    assert.strictEqual(result.ok, false);
    if (result.ok) return;
    assert(result.reason.includes('absolute'));
  });

  test('rejects path traversal with `..`', () => {
    const result = buildRealRepoApplyPlan(
      makeInput({ files: [{ path: '../secret.ts', content: 'x' }] })
    );
    assert.strictEqual(result.ok, false);
    if (result.ok) return;
    assert(result.reason.includes('traversal'));
  });

  test('rejects backslash paths', () => {
    const result = buildRealRepoApplyPlan(
      makeInput({ files: [{ path: 'src\\file.ts', content: 'x' }] })
    );
    assert.strictEqual(result.ok, false);
    if (result.ok) return;
    assert(result.reason.includes('backslash'));
  });

  test('rejects non-string content', () => {
    const result = buildRealRepoApplyPlan(
      makeInput({ files: [{ path: 'a.ts', content: 123 as unknown as string }] })
    );
    assert.strictEqual(result.ok, false);
    if (result.ok) return;
    assert(result.reason.includes('content is not a string'));
  });

  test('rejects duplicate existingPaths after trimming', () => {
    const result = buildRealRepoApplyPlan(
      makeInput({ existingPaths: ['a.ts', '  a.ts  '] })
    );
    assert.strictEqual(result.ok, false);
    if (result.ok) return;
    assert(result.reason.includes('Duplicate existingPaths'));
  });

  test('rejects invalid existingPaths', () => {
    const result = buildRealRepoApplyPlan(
      makeInput({ existingPaths: ['../bad.ts'] })
    );
    assert.strictEqual(result.ok, false);
    if (result.ok) return;
    assert(result.reason.includes('traversal'));
  });

  test('does not mutate input objects', () => {
    const input = makeInput({
      taskId: '  t  ',
      files: [{ path: '  a.ts  ', content: 'x' }],
    });
    const originalPath = input.files[0].path;
    const originalTaskId = input.taskId;
    buildRealRepoApplyPlan(input);
    assert.strictEqual(input.files[0].path, originalPath);
    assert.strictEqual(input.taskId, originalTaskId);
  });

  test('includes all safety messages in ok result', () => {
    const result = buildRealRepoApplyPlan(makeInput());
    assert.strictEqual(result.ok, true);
    if (!result.ok) return;
    assert(result.safetyMessages.includes('No commit will be made'));
    assert(result.safetyMessages.includes('No push will be performed'));
    assert(result.safetyMessages.includes('No merge will be performed'));
    assert(result.safetyMessages.includes('Main branch will not be touched'));
    assert(result.safetyMessages.includes('Provider will not be called'));
  });

  test('includes safety messages in rejected result', () => {
    const result = buildRealRepoApplyPlan(makeInput({ taskId: '' }));
    assert.strictEqual(result.ok, false);
    if (result.ok) return;
    assert(result.safetyMessages.includes('No commit will be made'));
    assert(result.safetyMessages.includes('No push will be performed'));
  });

  test('does not import/use fs/git/env/network/API keys/state', () => {
    const source = readFileSync(
      join(process.cwd(), 'src', 'real-repo-apply-plan.ts'),
      'utf-8'
    );
    const forbidden = [
      'fs',
      'child_process',
      'git-manager',
      'state-manager',
      'patch-engine',
      'ai-client',
      'provider-call',
      'dotenv',
      'process.env',
    ];
    for (const f of forbidden) {
      assert(
        !source.includes(f),
        `Source must not reference ${f}`
      );
    }
  });
});

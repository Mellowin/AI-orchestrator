import { describe, test } from 'node:test';
import assert from 'node:assert';
import type {
  Task,
  Check,
  Guardrails,
  RunState,
  RunStatus,
  KimiOutput,
  FileUpdate,
  ReviewVerdict,
  ContextPackage,
  ValidationResult,
  RunResult,
  DiffStat,
  PatchManifestEntry,
} from '../src/types.js';

describe('types contracts', () => {
  test('Task sample is valid', () => {
    const check: Check = { command: 'npm', args: ['run', 'lint'] };
    const guardrails: Guardrails = {
      deny_modify: ['.env', '.env.*'],
      require_tests: false,
      auto_commit: false,
      auto_push: false,
      auto_merge: false,
    };
    const task: Task = {
      id: 'demo-task',
      title: 'Demo Task',
      repo_path: './demo-repo',
      base_branch: 'main',
      work_branch: 'ai/demo-task',
      goal: 'Add demo feature',
      context_files: ['src/index.ts'],
      checks: [check],
      guardrails,
    };
    assert.strictEqual(task.id, 'demo-task');
    assert.strictEqual(task.guardrails.auto_commit, false);
    assert.strictEqual(task.checks[0].command, 'npm');
  });

  test('RunState sample is valid', () => {
    const status: RunStatus = 'coding';
    const state: RunState = {
      task_id: 'demo-task',
      status,
      current_attempt: 1,
      branch: 'ai/demo-task',
      repo_path: './demo-repo',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    assert.strictEqual(state.status, 'coding');
    assert.strictEqual(state.current_attempt, 1);
  });

  test('KimiOutput and FileUpdate sample is valid', () => {
    const file: FileUpdate = { path: 'src/index.ts', content: 'export const x = 1;' };
    const output: KimiOutput = {
      mode: 'file_update',
      files: [file],
      notes: 'Update index',
    };
    assert.strictEqual(output.mode, 'file_update');
    assert.strictEqual(output.files[0].path, 'src/index.ts');
  });

  test('ReviewVerdict sample is valid', () => {
    const verdict: ReviewVerdict = {
      verdict: 'needs_changes',
      critical_issues: ['Missing validation'],
      requested_changes: ['Add tests'],
      summary_for_human: 'Needs more work',
    };
    assert.strictEqual(verdict.verdict, 'needs_changes');
  });

  test('ContextPackage sample is valid', () => {
    const ctx: ContextPackage = {
      task_summary: 'Demo',
      goal: 'Add feature',
      constraints: ['No breaking changes'],
      files: [{ path: 'src/index.ts', content: '' }],
    };
    assert.strictEqual(ctx.files.length, 1);
  });

  test('ValidationResult sample is valid', () => {
    const ok: ValidationResult = { ok: true };
    const fail: ValidationResult = { ok: false, reason: 'Too large' };
    assert.strictEqual(ok.ok, true);
    assert.strictEqual(fail.reason, 'Too large');
  });

  test('RunResult sample is valid', () => {
    const result: RunResult = { success: true, logs: 'All good' };
    assert.strictEqual(result.success, true);
  });

  test('DiffStat sample is valid', () => {
    const diff: DiffStat = {
      files: ['src/index.ts'],
      insertions: 10,
      deletions: 2,
      binaryFiles: [],
    };
    assert.strictEqual(diff.insertions, 10);
  });

  test('PatchManifestEntry sample is valid', () => {
    const entry: PatchManifestEntry = {
      path: 'src/index.ts',
      existedBefore: true,
      backupPath: 'runs/demo-task/attempt-1/files-before/src/index.ts',
    };
    assert.strictEqual(entry.existedBefore, true);
  });

  test('all RunStatus variants are assignable', () => {
    const statuses: RunStatus[] = [
      'pending',
      'running',
      'coding',
      'patching',
      'running_checks',
      'reviewing',
      'approved',
      'rejected',
      'failed',
      'failed_guardrails',
      'failed_max_attempts',
    ];
    assert.strictEqual(statuses.length, 11);
  });
});

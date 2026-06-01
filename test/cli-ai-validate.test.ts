import { spawnSync } from 'node:child_process';
import { describe, test } from 'node:test';
import assert from 'node:assert';
import { existsSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createTempTasksFile } from './helpers/temp-tasks-file.js';

const TASK_ID = 'ai-validate-test-task';

function cleanTempTasksFile(tmpTasks: string): void {
  const dir = dirname(tmpTasks);
  if (existsSync(dir)) {
    rmSync(dir, { recursive: true, force: true });
  }
}

function cleanOutput(taskId: string): void {
  const dir = join(process.cwd(), 'runs', taskId);
  if (existsSync(dir)) {
    rmSync(dir, { recursive: true });
  }
}

function runAiValidate(
  taskId: string,
  envOverrides: Record<string, string> = {}
): { status: number; stdout: string; stderr: string } {
  const env = { ...process.env };
  delete env.AI_PROVIDER;
  delete env.MOCK_AI_RESPONSE;
  delete env.KIMI_API_KEY;
  delete env.KIMI_MODEL;
  delete env.KIMI_BASE_URL;
  delete env.OPENAI_API_KEY;
  delete env.MOCK_AI;
  Object.assign(env, envOverrides);

  const result = spawnSync(
    `npx tsx "${join(process.cwd(), 'src', 'cli.ts')}" ai-validate ${taskId}`,
    {
      cwd: process.cwd(),
      env,
      encoding: 'utf-8',
      shell: true,
      timeout: 15000,
    }
  );
  return {
    status: result.status ?? 1,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  };
}

describe('cli ai-validate', () => {
  test('succeeds for valid ai-output.json', () => {
    const tmpTasks = createTempTasksFile({ prefix: 'ai-validate', taskId: TASK_ID, allowModify: ['src/**'] });
    cleanOutput(TASK_ID);
    try {
      const runTaskDir = join(process.cwd(), 'runs', TASK_ID);
      mkdirSync(runTaskDir, { recursive: true });
      writeFileSync(
        join(runTaskDir, 'ai-output.json'),
        '{"mode":"file_update","files":[{"path":"src/main.ts","content":"x"}]}',
        'utf-8'
      );

      const result = runAiValidate(TASK_ID, { TASKS_FILE: tmpTasks });
      assert.strictEqual(result.status, 0, `Expected success, got stderr: ${result.stderr}`);
      assert(result.stdout.includes('[ai-validate] Valid AI output'), `Expected Valid AI output, got stdout: ${result.stdout}`);
      assert(result.stdout.includes('[ai-validate] Guardrails: ok'), `Expected Guardrails: ok, got stdout: ${result.stdout}`);
      assert(!existsSync(join(runTaskDir, 'state.json')), 'state.json should not exist');
      assert(!existsSync(join(runTaskDir, 'attempt-1')), 'attempt-1 should not exist');
    } finally {
      cleanOutput(TASK_ID);
      cleanTempTasksFile(tmpTasks);
    }
  });

  test('fails when ai-output.json is missing', () => {
    const tmpTasks = createTempTasksFile({ prefix: 'ai-validate', taskId: TASK_ID, allowModify: ['src/**'] });
    cleanOutput(TASK_ID);
    try {
      const runTaskDir = join(process.cwd(), 'runs', TASK_ID);
      if (existsSync(runTaskDir)) {
        rmSync(runTaskDir, { recursive: true });
      }

      const result = runAiValidate(TASK_ID, { TASKS_FILE: tmpTasks });
      assert.strictEqual(result.status, 1, `Expected failure, got stderr: ${result.stderr}`);
      assert(
        result.stderr.includes('ai-output.json not found. Run ai-generate first.'),
        `Expected missing file message, got stderr: ${result.stderr}`
      );
      assert(!existsSync(join(runTaskDir, 'state.json')), 'state.json should not exist');
      assert(!existsSync(join(runTaskDir, 'attempt-1')), 'attempt-1 should not exist');
    } finally {
      cleanOutput(TASK_ID);
      cleanTempTasksFile(tmpTasks);
    }
  });

  test('fails guardrails for denied path', () => {
    const tmpTasks = createTempTasksFile({ prefix: 'ai-validate', taskId: TASK_ID, allowModify: ['src/**'] });
    cleanOutput(TASK_ID);
    try {
      const runTaskDir = join(process.cwd(), 'runs', TASK_ID);
      mkdirSync(runTaskDir, { recursive: true });
      writeFileSync(
        join(runTaskDir, 'ai-output.json'),
        '{"mode":"file_update","files":[{"path":".env","content":"SECRET=1"}]}',
        'utf-8'
      );

      const result = runAiValidate(TASK_ID, { TASKS_FILE: tmpTasks });
      assert.strictEqual(result.status, 1, `Expected failure, got stderr: ${result.stderr}`);
      assert(
        result.stderr.includes('[ai-validate] Guardrails failed'),
        `Expected guardrails failed, got stderr: ${result.stderr}`
      );
      assert(!existsSync(join(runTaskDir, 'state.json')), 'state.json should not exist');
      assert(!existsSync(join(runTaskDir, 'attempt-1')), 'attempt-1 should not exist');
    } finally {
      cleanOutput(TASK_ID);
      cleanTempTasksFile(tmpTasks);
    }
  });

  test('ai-validate succeeds for fenced json ai-output', () => {
    const tmpTasks = createTempTasksFile({ prefix: 'ai-validate', taskId: TASK_ID, allowModify: ['src/**'] });
    cleanOutput(TASK_ID);
    try {
      const runTaskDir = join(process.cwd(), 'runs', TASK_ID);
      mkdirSync(runTaskDir, { recursive: true });
      writeFileSync(
        join(runTaskDir, 'ai-output.json'),
        '```json\n{"mode":"file_update","files":[{"path":"src/main.ts","content":"x"}]}\n```',
        'utf-8'
      );

      const result = runAiValidate(TASK_ID, { TASKS_FILE: tmpTasks });
      assert.strictEqual(result.status, 0, `Expected success, got stderr: ${result.stderr}`);
      assert(result.stdout.includes('[ai-validate] Valid AI output'), `Expected Valid AI output, got stdout: ${result.stdout}`);
      assert(result.stdout.includes('[ai-validate] Guardrails: ok'), `Expected Guardrails: ok, got stdout: ${result.stdout}`);
      assert(!existsSync(join(runTaskDir, 'state.json')), 'state.json should not exist');
      assert(!existsSync(join(runTaskDir, 'attempt-1')), 'attempt-1 should not exist');
    } finally {
      cleanOutput(TASK_ID);
      cleanTempTasksFile(tmpTasks);
    }
  });

  test('ai-validate succeeds for empty files array', () => {
    const tmpTasks = createTempTasksFile({ prefix: 'ai-validate', taskId: TASK_ID, allowModify: ['src/**'] });
    cleanOutput(TASK_ID);
    try {
      const runTaskDir = join(process.cwd(), 'runs', TASK_ID);
      mkdirSync(runTaskDir, { recursive: true });
      writeFileSync(
        join(runTaskDir, 'ai-output.json'),
        '{"mode":"file_update","files":[],"notes":"Cannot safely modify files because the request is unclear"}',
        'utf-8'
      );

      const result = runAiValidate(TASK_ID, { TASKS_FILE: tmpTasks });
      assert.strictEqual(result.status, 0, `Expected success, got stderr: ${result.stderr}`);
      assert(result.stdout.includes('[ai-validate] Files: 0'), `Expected Files: 0, got stdout: ${result.stdout}`);
      assert(result.stdout.includes('[ai-validate] No file changes proposed'), `Expected No file changes proposed, got stdout: ${result.stdout}`);
      assert(result.stdout.includes('[ai-validate] Notes:'), `Expected Notes, got stdout: ${result.stdout}`);
      assert(result.stdout.includes('[ai-validate] Guardrails: ok'), `Expected Guardrails: ok, got stdout: ${result.stdout}`);
      assert(!existsSync(join(runTaskDir, 'state.json')), 'state.json should not exist');
      assert(!existsSync(join(runTaskDir, 'attempt-1')), 'attempt-1 should not exist');
    } finally {
      cleanOutput(TASK_ID);
      cleanTempTasksFile(tmpTasks);
    }
  });
});

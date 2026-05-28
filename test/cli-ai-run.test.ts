import { spawnSync } from 'node:child_process';
import { describe, test } from 'node:test';
import assert from 'node:assert';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createTempTasksFile } from './helpers/temp-tasks-file.js';

const TASK_ID = 'ai-run-test-task';



function runAiRun(
  taskId: string,
  extraArgs: string[] = [],
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
    `npx tsx "${join(process.cwd(), 'src', 'cli.ts')}" ai-run ${taskId} ${extraArgs.join(' ')}`,
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

function cleanOutput(taskId: string): void {
  const dir = join(process.cwd(), 'runs', taskId);
  if (existsSync(dir)) {
    rmSync(dir, { recursive: true });
  }
}

describe('cli ai-run', () => {
  test('runs generate validate preview in mock mode', () => {
    const tmpTasks = createTempTasksFile({ prefix: 'ai-run', taskId: TASK_ID });
    cleanOutput(TASK_ID);
    try {
      const result = runAiRun(TASK_ID, [], {
        AI_PROVIDER: 'mock',
        MOCK_AI_RESPONSE: '{"mode":"file_update","files":[]}',
        TASKS_FILE: tmpTasks,
      });
      assert.strictEqual(result.status, 0, `Expected success, got stderr: ${result.stderr}`);
      assert(
        result.stdout.includes('[ai-run] Step 1/3: ai-generate'),
        `Expected step 1 log, got stdout: ${result.stdout}`
      );
      assert(
        result.stdout.includes('[ai-run] Step 2/3: ai-validate'),
        `Expected step 2 log, got stdout: ${result.stdout}`
      );
      assert(
        result.stdout.includes('[ai-run] Step 3/3: ai-preview'),
        `Expected step 3 log, got stdout: ${result.stdout}`
      );
      assert(
        result.stdout.includes('ai-apply manually'),
        `Expected manual apply message, got stdout: ${result.stdout}`
      );
      assert(
        existsSync(join(process.cwd(), 'runs', TASK_ID, 'ai-output.json')),
        'ai-output.json should exist'
      );
    } finally {
      cleanOutput(TASK_ID);
      if (existsSync(dirname(tmpTasks))) rmSync(dirname(tmpTasks), { recursive: true, force: true });
    }
  });

  test('stops when generated output is invalid', () => {
    const tmpTasks = createTempTasksFile({ prefix: 'ai-run', taskId: TASK_ID });
    cleanOutput(TASK_ID);
    try {
      const result = runAiRun(TASK_ID, [], {
        AI_PROVIDER: 'mock',
        MOCK_AI_RESPONSE: 'not-json',
        TASKS_FILE: tmpTasks,
      });
      assert.notStrictEqual(result.status, 0, `Expected failure, got stderr: ${result.stderr}`);
      const combined = result.stdout + result.stderr;
      assert(
        combined.includes('Error') || combined.includes('error'),
        `Expected error indication, got: ${combined}`
      );
      assert(
        !result.stdout.includes('[ai-run] Step 3/3: ai-preview'),
        `Preview should not run after validation failure`
      );
    } finally {
      cleanOutput(TASK_ID);
      if (existsSync(dirname(tmpTasks))) rmSync(dirname(tmpTasks), { recursive: true, force: true });
    }
  });

  test('does not run ai-apply', () => {
    const tmpTasks = createTempTasksFile({ prefix: 'ai-run', taskId: TASK_ID });
    cleanOutput(TASK_ID);
    try {
      const result = runAiRun(TASK_ID, [], {
        AI_PROVIDER: 'mock',
        MOCK_AI_RESPONSE: '{"mode":"file_update","files":[]}',
        TASKS_FILE: tmpTasks,
      });
      assert.strictEqual(result.status, 0, `Expected success, got stderr: ${result.stderr}`);
      const runDir = join(process.cwd(), 'runs', TASK_ID);
      assert(
        !existsSync(join(runDir, 'state.json')),
        'state.json should not exist (apply was not run)'
      );
      const entries = existsSync(runDir) ? readdirSync(runDir) : [];
      const attempts = entries.filter((e) => e.startsWith('attempt-'));
      assert.strictEqual(
        attempts.length,
        0,
        `Expected no attempt folders, got: ${JSON.stringify(attempts)}`
      );
    } finally {
      cleanOutput(TASK_ID);
      if (existsSync(dirname(tmpTasks))) rmSync(dirname(tmpTasks), { recursive: true, force: true });
    }
  });

  test('ai-run prints backup path when existing ai-output is backed up', () => {
    const tmpTasks = createTempTasksFile({ prefix: 'ai-run', taskId: TASK_ID });
    cleanOutput(TASK_ID);
    try {
      const runDir = join(process.cwd(), 'runs', TASK_ID);
      mkdirSync(runDir, { recursive: true });
      writeFileSync(join(runDir, 'ai-output.json'), '{"old":"content"}', 'utf-8');

      const result = runAiRun(TASK_ID, [], {
        AI_PROVIDER: 'mock',
        MOCK_AI_RESPONSE: '{"mode":"file_update","files":[]}',
        TASKS_FILE: tmpTasks,
      });
      assert.strictEqual(result.status, 0, `Expected success, got stderr: ${result.stderr}`);
      assert(
        result.stdout.includes('[ai-run] Backup:'),
        `Expected backup log in stdout, got: ${result.stdout}`
      );
      assert(
        result.stdout.includes('ai-output.backup-'),
        `Expected backup filename in stdout, got: ${result.stdout}`
      );

      const files = readdirSync(runDir);
      const backups = files.filter((f) => f.startsWith('ai-output.backup-') && f.endsWith('.json'));
      assert.strictEqual(backups.length, 1, `Expected exactly one backup file, got: ${JSON.stringify(files)}`);

      const backupContent = readFileSync(join(runDir, backups[0]!), 'utf-8');
      assert.strictEqual(backupContent, '{"old":"content"}', 'Backup should contain old content');
    } finally {
      cleanOutput(TASK_ID);
      if (existsSync(dirname(tmpTasks))) rmSync(dirname(tmpTasks), { recursive: true, force: true });
    }
  });

  test('respects TASKS_FILE', () => {
    const tmpTasks = createTempTasksFile({ prefix: 'ai-run', taskId: TASK_ID });
    cleanOutput(TASK_ID);
    try {
      const result = runAiRun(TASK_ID, [], {
        AI_PROVIDER: 'mock',
        MOCK_AI_RESPONSE: '{"mode":"file_update","files":[]}',
        TASKS_FILE: tmpTasks,
      });
      assert.strictEqual(result.status, 0, `Expected success, got stderr: ${result.stderr}`);
      assert(
        existsSync(join(process.cwd(), 'runs', TASK_ID, 'ai-output.json')),
        'ai-output.json should exist'
      );
    } finally {
      cleanOutput(TASK_ID);
      if (existsSync(dirname(tmpTasks))) rmSync(dirname(tmpTasks), { recursive: true, force: true });
    }
  });
});

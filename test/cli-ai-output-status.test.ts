import { spawnSync } from 'node:child_process';
import { describe, test } from 'node:test';
import assert from 'node:assert';
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const TASK_ID = 'ai-output-status-test-task';

function runAiOutputStatus(
  taskId: string
): { status: number; stdout: string; stderr: string } {
  const env = { ...process.env };
  delete env.AI_PROVIDER;
  delete env.MOCK_AI_RESPONSE;
  delete env.KIMI_API_KEY;
  delete env.KIMI_MODEL;
  delete env.KIMI_BASE_URL;
  delete env.OPENAI_API_KEY;
  delete env.MOCK_AI;

  const result = spawnSync(
    `npx tsx "${join(process.cwd(), 'src', 'cli.ts')}" ai-output-status ${taskId}`,
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

describe('cli ai-output-status', () => {
  test('reports missing output', () => {
    cleanOutput(TASK_ID);
    try {
      const result = runAiOutputStatus(TASK_ID);
      assert.notStrictEqual(result.status, 0, `Expected failure, got stderr: ${result.stderr}`);
      assert(
        result.stdout.includes('[ai-output-status] Output: missing'),
        `Expected missing output, got stdout: ${result.stdout}`
      );
      assert(
        result.stdout.includes('[ai-output-status] Backups: 0'),
        `Expected 0 backups, got stdout: ${result.stdout}`
      );
    } finally {
      cleanOutput(TASK_ID);
    }
  });

  test('reports valid output and backups', () => {
    cleanOutput(TASK_ID);
    try {
      const runDir = join(process.cwd(), 'runs', TASK_ID);
      mkdirSync(runDir, { recursive: true });
      writeFileSync(
        join(runDir, 'ai-output.json'),
        '{"mode":"file_update","files":[{"path":"README.md","content":"x"},{"path":"src/main.ts","content":"y"}],"notes":"ok"}',
        'utf-8'
      );
      writeFileSync(join(runDir, 'ai-output.backup-20240115-093046.json'), '{"old":"content2"}', 'utf-8');
      writeFileSync(join(runDir, 'ai-output.backup-20240115-093045.json'), '{"old":"content1"}', 'utf-8');

      const result = runAiOutputStatus(TASK_ID);
      assert.strictEqual(result.status, 0, `Expected success, got stderr: ${result.stderr}`);
      assert(
        result.stdout.includes('[ai-output-status] Output: present'),
        `Expected present output, got stdout: ${result.stdout}`
      );
      assert(
        result.stdout.includes('[ai-output-status] Valid: yes'),
        `Expected valid yes, got stdout: ${result.stdout}`
      );
      assert(
        result.stdout.includes('[ai-output-status] Files: 2'),
        `Expected 2 files, got stdout: ${result.stdout}`
      );
      assert(
        result.stdout.includes('[ai-output-status] Paths:'),
        `Expected Paths, got stdout: ${result.stdout}`
      );
      assert(
        result.stdout.includes('  - README.md'),
        `Expected README.md path, got stdout: ${result.stdout}`
      );
      assert(
        result.stdout.includes('  - src/main.ts'),
        `Expected src/main.ts path, got stdout: ${result.stdout}`
      );
      assert(
        result.stdout.includes('[ai-output-status] Notes: ok'),
        `Expected notes, got stdout: ${result.stdout}`
      );
      assert(
        result.stdout.includes('[ai-output-status] Backups: 2'),
        `Expected 2 backups, got stdout: ${result.stdout}`
      );
      assert(
        result.stdout.includes('ai-output.backup-20240115-093045.json'),
        `Expected backup 1, got stdout: ${result.stdout}`
      );
      assert(
        result.stdout.includes('ai-output.backup-20240115-093046.json'),
        `Expected backup 2, got stdout: ${result.stdout}`
      );

      const first = result.stdout.indexOf('ai-output.backup-20240115-093045.json');
      const second = result.stdout.indexOf('ai-output.backup-20240115-093046.json');
      assert.notStrictEqual(first, -1, 'First backup should appear in stdout');
      assert.notStrictEqual(second, -1, 'Second backup should appear in stdout');
      assert(first < second, 'Backups should be sorted ascending by filename');
    } finally {
      cleanOutput(TASK_ID);
    }
  });

  test('reports invalid output', () => {
    cleanOutput(TASK_ID);
    try {
      const runDir = join(process.cwd(), 'runs', TASK_ID);
      mkdirSync(runDir, { recursive: true });
      writeFileSync(join(runDir, 'ai-output.json'), 'not-json', 'utf-8');

      const result = runAiOutputStatus(TASK_ID);
      assert.notStrictEqual(result.status, 0, `Expected failure, got stderr: ${result.stderr}`);
      assert(
        result.stdout.includes('[ai-output-status] Output: present'),
        `Expected present output, got stdout: ${result.stdout}`
      );
      assert(
        result.stdout.includes('[ai-output-status] Valid: no'),
        `Expected valid no, got stdout: ${result.stdout}`
      );
      assert(
        result.stdout.includes('[ai-output-status] Error:'),
        `Expected error, got stdout: ${result.stdout}`
      );
      assert(
        result.stdout.includes('[ai-output-status] Backups: 0'),
        `Expected 0 backups, got stdout: ${result.stdout}`
      );
    } finally {
      cleanOutput(TASK_ID);
    }
  });

  test('reports valid fenced output', () => {
    cleanOutput(TASK_ID);
    try {
      const runDir = join(process.cwd(), 'runs', TASK_ID);
      mkdirSync(runDir, { recursive: true });
      writeFileSync(
        join(runDir, 'ai-output.json'),
        '```json\n{"mode":"file_update","files":[{"path":"README.md","content":"x"}],"notes":"fenced"}\n```',
        'utf-8'
      );

      const result = runAiOutputStatus(TASK_ID);
      assert.strictEqual(result.status, 0, `Expected success, got stderr: ${result.stderr}`);
      assert(
        result.stdout.includes('[ai-output-status] Output: present'),
        `Expected present output, got stdout: ${result.stdout}`
      );
      assert(
        result.stdout.includes('[ai-output-status] Valid: yes'),
        `Expected valid yes, got stdout: ${result.stdout}`
      );
      assert(
        result.stdout.includes('[ai-output-status] Files: 1'),
        `Expected 1 file, got stdout: ${result.stdout}`
      );
      assert(
        result.stdout.includes('[ai-output-status] Notes: fenced'),
        `Expected notes, got stdout: ${result.stdout}`
      );
      assert(
        result.stdout.includes('[ai-output-status] Backups: 0'),
        `Expected 0 backups, got stdout: ${result.stdout}`
      );
    } finally {
      cleanOutput(TASK_ID);
    }
  });

  test('reports missing output with backups', () => {
    cleanOutput(TASK_ID);
    try {
      const runDir = join(process.cwd(), 'runs', TASK_ID);
      mkdirSync(runDir, { recursive: true });
      writeFileSync(join(runDir, 'ai-output.backup-20240115-093045.json'), '{"old":"content"}', 'utf-8');

      const result = runAiOutputStatus(TASK_ID);
      assert.notStrictEqual(result.status, 0, `Expected failure, got stderr: ${result.stderr}`);
      assert(
        result.stdout.includes('[ai-output-status] Output: missing'),
        `Expected missing output, got stdout: ${result.stdout}`
      );
      assert(
        result.stdout.includes('[ai-output-status] Backups: 1'),
        `Expected 1 backup, got stdout: ${result.stdout}`
      );
      assert(
        result.stdout.includes('ai-output.backup-20240115-093045.json'),
        `Expected backup filename, got stdout: ${result.stdout}`
      );
      assert(
        !result.stdout.includes('[ai-output-status] Valid:'),
        `Should not show Valid when output is missing, got stdout: ${result.stdout}`
      );
    } finally {
      cleanOutput(TASK_ID);
    }
  });

  test('reports invalid output schema', () => {
    cleanOutput(TASK_ID);
    try {
      const runDir = join(process.cwd(), 'runs', TASK_ID);
      mkdirSync(runDir, { recursive: true });
      writeFileSync(
        join(runDir, 'ai-output.json'),
        '{"mode":"wrong","files":[]}',
        'utf-8'
      );

      const result = runAiOutputStatus(TASK_ID);
      assert.notStrictEqual(result.status, 0, `Expected failure, got stderr: ${result.stderr}`);
      assert(
        result.stdout.includes('[ai-output-status] Output: present'),
        `Expected present output, got stdout: ${result.stdout}`
      );
      assert(
        result.stdout.includes('[ai-output-status] Valid: no'),
        `Expected valid no, got stdout: ${result.stdout}`
      );
      assert(
        result.stdout.includes('[ai-output-status] Error:'),
        `Expected error, got stdout: ${result.stdout}`
      );
      assert(
        result.stdout.includes('Invalid KimiOutput mode'),
        `Expected mode error, got stdout: ${result.stdout}`
      );
      assert(
        result.stdout.includes('[ai-output-status] Backups: 0'),
        `Expected 0 backups, got stdout: ${result.stdout}`
      );
      assert(
        !result.stdout.includes('[ai-output-status] Files:'),
        `Should not show Files when invalid, got stdout: ${result.stdout}`
      );
      assert(
        !result.stdout.includes('[ai-output-status] Paths:'),
        `Should not show Paths when invalid, got stdout: ${result.stdout}`
      );
      assert(
        !result.stdout.includes('[ai-output-status] Notes:'),
        `Should not show Notes when invalid, got stdout: ${result.stdout}`
      );
    } finally {
      cleanOutput(TASK_ID);
    }
  });

  test('does not require task config', () => {
    cleanOutput(TASK_ID);
    try {
      const runDir = join(process.cwd(), 'runs', TASK_ID);
      mkdirSync(runDir, { recursive: true });
      writeFileSync(
        join(runDir, 'ai-output.json'),
        '{"mode":"file_update","files":[],"notes":"empty"}',
        'utf-8'
      );

      const result = runAiOutputStatus(TASK_ID);
      assert.strictEqual(result.status, 0, `Expected success, got stderr: ${result.stderr}`);
      assert(
        result.stdout.includes('[ai-output-status] Valid: yes'),
        `Expected valid yes, got stdout: ${result.stdout}`
      );
      assert(
        !result.stdout.includes('[ai-output-status] Paths:'),
        `Should not show Paths when files is empty, got stdout: ${result.stdout}`
      );
    } finally {
      cleanOutput(TASK_ID);
    }
  });
});

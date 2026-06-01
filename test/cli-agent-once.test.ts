import { spawnSync } from 'node:child_process';
import { describe, test } from 'node:test';
import assert from 'node:assert';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const TASK_ID = 'agent-once-test-task';

function getCleanEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.AI_PROVIDER;
  delete env.MOCK_AI_RESPONSE;
  delete env.KIMI_API_KEY;
  delete env.KIMI_MODEL;
  delete env.KIMI_BASE_URL;
  delete env.OPENAI_API_KEY;
  delete env.MOCK_AI;
  return env;
}

function runCli(args: string[]): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(
    `npx tsx "${join(process.cwd(), 'src', 'cli.ts')}" ${args.join(' ')}`,
    {
      cwd: process.cwd(),
      env: getCleanEnv(),
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

describe('cli agent-once', () => {
  test('prints planned agent-once steps', () => {
    cleanOutput(TASK_ID);
    try {
      const result = runCli(['agent-once', TASK_ID]);
      assert.strictEqual(result.status, 0, `Expected success, got stderr: ${result.stderr}`);
      assert(
        result.stdout.includes(`[agent-once] Task: ${TASK_ID}`),
        `Expected task header, got stdout: ${result.stdout}`
      );
      assert(
        result.stdout.includes('[agent-once] Mode: dry-run'),
        `Expected dry-run mode, got stdout: ${result.stdout}`
      );
      assert(
        result.stdout.includes('[agent-once] Status: planned'),
        `Expected planned status, got stdout: ${result.stdout}`
      );
      assert(
        result.stdout.includes('[agent-once] Steps:'),
        `Expected steps header, got stdout: ${result.stdout}`
      );
      assert(result.stdout.includes('1. ai-run'), `Expected step 1, got stdout: ${result.stdout}`);
      assert(
        result.stdout.includes('2. ai-output-status'),
        `Expected step 2, got stdout: ${result.stdout}`
      );
      assert(result.stdout.includes('3. ai-apply'), `Expected step 3, got stdout: ${result.stdout}`);
      assert(result.stdout.includes('4. checks'), `Expected step 4, got stdout: ${result.stdout}`);
      assert(result.stdout.includes('5. commit'), `Expected step 5, got stdout: ${result.stdout}`);
      assert(result.stdout.includes('6. review'), `Expected step 6, got stdout: ${result.stdout}`);
      assert(
        result.stdout.includes('[agent-once] No actions executed yet.'),
        `Expected no-actions message, got stdout: ${result.stdout}`
      );
    } finally {
      cleanOutput(TASK_ID);
    }
  });

  test('does not create run directory', () => {
    cleanOutput(TASK_ID);
    const runDir = join(process.cwd(), 'runs', TASK_ID);
    const result = runCli(['agent-once', TASK_ID]);
    assert.strictEqual(result.status, 0, `Expected success, got stderr: ${result.stderr}`);
    assert(!existsSync(runDir), `Expected run directory to not exist: ${runDir}`);
  });

  test('usage includes agent-once', () => {
    const result = runCli([]);
    assert.notStrictEqual(result.status, 0, `Expected failure, got stderr: ${result.stderr}`);
    assert(result.stderr.includes('Usage:'), `Expected Usage in stderr, got: ${result.stderr}`);
    assert(
      result.stderr.includes('agent-once'),
      `Expected agent-once in usage, got: ${result.stderr}`
    );
  });

  test('supports explicit dry-run flag', () => {
    cleanOutput(TASK_ID);
    try {
      const result = runCli(['agent-once', TASK_ID, '--dry-run']);
      assert.strictEqual(result.status, 0, `Expected success, got stderr: ${result.stderr}`);
      assert(
        result.stdout.includes('[agent-once] Mode: dry-run'),
        `Expected dry-run mode, got stdout: ${result.stdout}`
      );
      assert(
        result.stdout.includes('[agent-once] No actions executed yet.'),
        `Expected no-actions message, got stdout: ${result.stdout}`
      );
    } finally {
      cleanOutput(TASK_ID);
    }
  });

  test('rejects unsupported flags', () => {
    cleanOutput(TASK_ID);
    const runDir = join(process.cwd(), 'runs', TASK_ID);
    try {
      const result = runCli(['agent-once', TASK_ID, '--execute']);
      assert.notStrictEqual(result.status, 0, `Expected failure, got stderr: ${result.stderr}`);
      assert(
        result.stderr.includes('[agent-once] Error:'),
        `Expected error prefix, got stderr: ${result.stderr}`
      );
      assert(
        result.stderr.includes('Unsupported flag: --execute'),
        `Expected unsupported flag message, got stderr: ${result.stderr}`
      );
      assert(!existsSync(runDir), `Expected run directory to not exist: ${runDir}`);
    } finally {
      cleanOutput(TASK_ID);
    }
  });
});

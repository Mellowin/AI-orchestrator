import { spawnSync } from 'node:child_process';
import { describe, test } from 'node:test';
import assert from 'node:assert';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveBackupPath } from '../src/backup-path.js';

function runAiGenerate(
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
    `npx tsx "${join(process.cwd(), 'src', 'cli.ts')}" ai-generate demo-task ${extraArgs.join(' ')}`,
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

function cleanOutput(): void {
  const dir = join(process.cwd(), 'runs', 'demo-task');
  if (existsSync(dir)) {
    rmSync(dir, { recursive: true });
  }
}

describe('cli ai-generate', () => {
  test('mock provider works without flag', () => {
    cleanOutput();
    try {
      const result = runAiGenerate([], {
        AI_PROVIDER: 'mock',
        MOCK_AI_RESPONSE: '{"mode":"file_update","files":[]}',
      });
      assert.strictEqual(result.status, 0, `Expected success, got stderr: ${result.stderr}`);
      assert(existsSync(join(process.cwd(), 'runs', 'demo-task', 'ai-output.json')), 'ai-output.json should exist');
    } finally {
      cleanOutput();
    }
  });

  test('kimi provider without flag is blocked before real HTTP', () => {
    cleanOutput();
    try {
      const result = runAiGenerate([], {
        AI_PROVIDER: 'kimi',
        KIMI_API_KEY: 'x',
        KIMI_MODEL: 'kimi-k2.6',
      });
      assert.strictEqual(result.status, 1, `Expected failure, got stderr: ${result.stderr}`);
      assert(
        result.stderr.includes('real AI providers require --allow-real-ai'),
        `Expected blocker message, got stderr: ${result.stderr}`
      );
      assert(!existsSync(join(process.cwd(), 'runs', 'demo-task', 'ai-output.json')), 'ai-output.json should not exist');
    } finally {
      cleanOutput();
    }
  });

  test('kimi provider with --allow-real-ai reaches client path without real HTTP', () => {
    cleanOutput();
    try {
      const result = runAiGenerate(['--allow-real-ai'], {
        AI_PROVIDER: 'kimi',
        KIMI_API_KEY: 'x',
        KIMI_MODEL: 'kimi-k2.6',
        KIMI_BASE_URL: 'not-a-url',
      });
      assert.strictEqual(result.status, 1, `Expected failure, got stderr: ${result.stderr}`);
      assert(
        !result.stderr.includes('real AI providers require --allow-real-ai'),
        `Should pass CLI guard, got stderr: ${result.stderr}`
      );
      assert(
        result.stderr.includes('[ai-generate] Error:'),
        `Should show ai-generate error, got stderr: ${result.stderr}`
      );
      const hasFetchError =
        result.stderr.includes('Failed to parse URL') ||
        result.stderr.includes('Invalid URL') ||
        result.stderr.includes('fetch failed');
      assert(
        hasFetchError,
        `Should fail on invalid URL before real HTTP, got stderr: ${result.stderr}`
      );
      assert(!existsSync(join(process.cwd(), 'runs', 'demo-task', 'ai-output.json')), 'ai-output.json should not exist');
    } finally {
      cleanOutput();
    }
  });

  test('creates backup when ai-output.json already exists', () => {
    cleanOutput();
    try {
      const runDir = join(process.cwd(), 'runs', 'demo-task');
      mkdirSync(runDir, { recursive: true });
      writeFileSync(join(runDir, 'ai-output.json'), '{"old":"content"}', 'utf-8');

      const result = runAiGenerate([], {
        AI_PROVIDER: 'mock',
        MOCK_AI_RESPONSE: '{"mode":"file_update","files":[]}',
      });
      assert.strictEqual(result.status, 0, `Expected success, got stderr: ${result.stderr}`);
      assert(existsSync(join(runDir, 'ai-output.json')), 'ai-output.json should exist');

      const files = readdirSync(runDir);
      const backups = files.filter((f) => f.startsWith('ai-output.backup-') && f.endsWith('.json'));
      assert.strictEqual(backups.length, 1, `Expected exactly one backup file, got: ${JSON.stringify(files)}`);
      assert.match(backups[0]!, /^ai-output\.backup-\d{8}-\d{6}(?:-\d+)?\.json$/);

      assert(
        result.stdout.includes('[ai-generate] Backup:'),
        `Expected backup log in stdout, got: ${result.stdout}`
      );
      assert(
        result.stdout.includes('ai-output.backup-'),
        `Expected backup filename in stdout, got: ${result.stdout}`
      );

      const backupContent = readFileSync(join(runDir, backups[0]!), 'utf-8');
      assert.strictEqual(backupContent, '{"old":"content"}', 'Backup should contain old content');

      const newContent = readFileSync(join(runDir, 'ai-output.json'), 'utf-8');
      assert.strictEqual(newContent, '{"mode":"file_update","files":[]}', 'New output should be written');
    } finally {
      cleanOutput();
    }
  });

  test('does not create backup when ai-output.json does not exist', () => {
    cleanOutput();
    try {
      const result = runAiGenerate([], {
        AI_PROVIDER: 'mock',
        MOCK_AI_RESPONSE: '{"mode":"file_update","files":[]}',
      });
      assert.strictEqual(result.status, 0, `Expected success, got stderr: ${result.stderr}`);
      const runDir = join(process.cwd(), 'runs', 'demo-task');
      const files = readdirSync(runDir);
      const backups = files.filter((f) => f.startsWith('ai-output.backup-') && f.endsWith('.json'));
      assert.strictEqual(backups.length, 0, `Expected no backup files, got: ${JSON.stringify(files)}`);
      assert(
        !result.stdout.includes('[ai-generate] Backup:'),
        `Should not log backup when no prior file exists, got stdout: ${result.stdout}`
      );
    } finally {
      cleanOutput();
    }
  });

  test('resolveBackupPath avoids collision by adding counter suffix', () => {
    cleanOutput();
    try {
      const runDir = join(process.cwd(), 'runs', 'demo-task');
      mkdirSync(runDir, { recursive: true });

      const fixedDate = new Date(Date.UTC(2024, 0, 15, 9, 30, 45));

      const path1 = resolveBackupPath(runDir, fixedDate);
      assert.strictEqual(path1, join(runDir, 'ai-output.backup-20240115-093045.json'));

      writeFileSync(path1, 'backup1', 'utf-8');

      const path2 = resolveBackupPath(runDir, fixedDate);
      assert.strictEqual(path2, join(runDir, 'ai-output.backup-20240115-093045-1.json'));

      writeFileSync(path2, 'backup2', 'utf-8');

      const path3 = resolveBackupPath(runDir, fixedDate);
      assert.strictEqual(path3, join(runDir, 'ai-output.backup-20240115-093045-2.json'));
    } finally {
      cleanOutput();
    }
  });
});

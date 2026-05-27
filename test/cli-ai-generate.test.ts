import { spawnSync } from 'node:child_process';
import { describe, test } from 'node:test';
import assert from 'node:assert';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';

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
});

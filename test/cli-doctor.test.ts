import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = process.cwd();

function runDoctor(envOverrides: Record<string, string | undefined> = {}, cwd: string = ROOT): {
  status: number | null;
  stdout: string;
  stderr: string;
} {
  const env: Record<string, string | undefined> = { ...process.env };
  for (const [key, value] of Object.entries(envOverrides)) {
    if (value === undefined) {
      delete env[key];
    } else {
      env[key] = value;
    }
  }
  const tsx = join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const cli = join(ROOT, 'src', 'cli.ts');
  const result = spawnSync(process.execPath, [tsx, cli, 'doctor'], { cwd, env, encoding: 'utf-8', shell: false });
  return {
    status: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  };
}

describe('cli doctor', () => {
  it('reports environment readiness with tokens present', () => {
    const result = runDoctor({
      KIMI_API_KEY: 'sk-test-key',
      GITHUB_TOKEN: 'github_pat_test_token',
    });
    const output = `${result.stdout}\n${result.stderr}`;
    assert.strictEqual(result.status, 0, output);
    assert.ok(output.includes('DOCTOR_READY_REAL_REPAIR') || output.includes('DOCTOR_READY_REAL_PR') || output.includes('DOCTOR_READY_WITH_CAVEATS'), output);
    assert.ok(output.includes('KIMI_API_KEY: present'), output);
    assert.ok(output.includes('GITHUB_TOKEN: present'), output);
    assert.ok(!output.includes('sk-test-key'), 'token value leaked');
    assert.ok(!output.includes('github_pat_test_token'), 'token value leaked');
  });

  it('reports safe readiness without tokens', () => {
    const result = runDoctor({
      AI_PROVIDER: 'mock',
      KIMI_API_KEY: '',
      GITHUB_TOKEN: '',
    });
    const output = `${result.stdout}\n${result.stderr}`;
    assert.strictEqual(result.status, 0, output);
    assert.ok(output.includes('DOCTOR_READY_SAFE') || output.includes('DOCTOR_READY_WITH_CAVEATS'), output);
    assert.ok(output.includes('KIMI_API_KEY: missing'), output);
    assert.ok(output.includes('GITHUB_TOKEN: missing'), output);
  });

  it('fails outside a git repository', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'doctor-no-git-'));
    try {
      const result = runDoctor({ AI_PROVIDER: 'mock', KIMI_API_KEY: '', GITHUB_TOKEN: '' }, tmpDir);
      const output = `${result.stdout}\n${result.stderr}`;
      assert.notStrictEqual(result.status, 0, output);
      assert.ok(output.includes('DOCTOR_FAILED'), output);
      assert.ok(output.includes('not a git repository'), output);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

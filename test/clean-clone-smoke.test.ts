import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = process.cwd();

function run(cmd: string, args: string[], cwd: string, timeout = 120000): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(cmd, args, { cwd, encoding: 'utf-8', shell: false, timeout });
  return {
    status: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  };
}

describe('clean clone smoke', () => {
  it('can install, run doctor, and exposes one-click scripts in a fresh clone', { timeout: 360000 }, () => {
    const cloneDir = mkdtempSync(join(tmpdir(), 'clean-clone-'));
    try {
      const cloneResult = run('git', ['clone', ROOT, cloneDir], tmpdir(), 120000);
      assert.strictEqual(cloneResult.status, 0, cloneResult.stderr);

      const pkg = JSON.parse(readFileSync(join(cloneDir, 'package.json'), 'utf-8'));
      assert.strictEqual(pkg.scripts['one-click'], 'tsx src/cli.ts autopilot-one-click');
      assert.strictEqual(pkg.scripts['doctor'], 'tsx src/cli.ts doctor');
      assert.ok(existsSync(join(cloneDir, 'docs', 'QUICKSTART.md')), 'QUICKSTART.md missing in clone');

      const installResult = run('npm', ['ci'], cloneDir, 240000);
      assert.strictEqual(installResult.status, 0, installResult.stdout + installResult.stderr);

      const env = { ...process.env };
      delete env.KIMI_API_KEY;
      delete env.GITHUB_TOKEN;
      delete env.OPENAI_API_KEY;
      const tsx = join(cloneDir, 'node_modules', 'tsx', 'dist', 'cli.mjs');
      const doctorResult = spawnSync(process.execPath, [tsx, 'src/cli.ts', 'doctor'], { cwd: cloneDir, env, encoding: 'utf-8', shell: false });
      const doctorOutput = `${doctorResult.stdout}\n${doctorResult.stderr}`;
      assert.strictEqual(doctorResult.status, 0, doctorOutput);
      assert.ok(doctorOutput.includes('DOCTOR_READY_SAFE') || doctorOutput.includes('DOCTOR_READY_WITH_CAVEATS'), doctorOutput);
      assert.ok(!doctorOutput.includes(env.KIMI_API_KEY ?? ''), 'token leaked');
    } finally {
      rmSync(cloneDir, { recursive: true, force: true });
    }
  });
});

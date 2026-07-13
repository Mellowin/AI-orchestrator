import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = process.cwd();
const TSX = join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');

function createTempGitRepo(): { path: string; cleanup: () => void } {
  const tmpBase = join(tmpdir(), `one-click-repo-${Date.now()}`);
  const repoPath = mkdtempSync(tmpBase);
  const originPath = mkdtempSync(`${tmpBase}-origin-`);

  function git(args: string[], cwd: string = repoPath) {
    const result = spawnSync('git', args, { cwd, encoding: 'utf-8', shell: false });
    if (result.status !== 0) {
      throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
    }
  }

  git(['init', '--bare'], originPath);
  git(['init']);
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'Test Runner']);
  git(['remote', 'add', 'origin', originPath]);
  writeFileSync(join(repoPath, 'README.md'), '# Sandbox\n', 'utf-8');
  git(['add', 'README.md']);
  git(['commit', '-m', 'initial']);
  const branchName = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repoPath, encoding: 'utf-8' }).stdout.trim();
  if (branchName !== 'main') {
    git(['branch', '-m', 'main']);
  }
  git(['push', '-u', 'origin', 'main']);

  return {
    path: repoPath,
    cleanup: () => {
      rmSync(repoPath, { recursive: true, force: true });
      rmSync(originPath, { recursive: true, force: true });
    },
  };
}

function runOneClick(args: string[], envOverrides: Record<string, string | undefined> = {}): {
  status: number | null;
  stdout: string;
  stderr: string;
} {
  const env: Record<string, string | undefined> = { ...process.env };
  for (const [key, value] of Object.entries(envOverrides)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  delete env.KIMI_API_KEY;
  delete env.GITHUB_TOKEN;
  delete env.OPENAI_API_KEY;
  const result = spawnSync(process.execPath, [TSX, 'src/cli.ts', 'autopilot-one-click', ...args], {
    cwd: ROOT,
    env,
    encoding: 'utf-8',
    shell: false,
  });
  return {
    status: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  };
}

describe('one-click package script', () => {
  it('safe one-click exits 0 without tokens and makes no commit', () => {
    const repo = createTempGitRepo();
    const outputDir = mkdtempSync(join(tmpdir(), 'one-click-report-'));
    try {
      const result = runOneClick([
        'Add a documentation note',
        '--preset', 'safe',
        '--repo-path', repo.path,
        '--base-branch', 'main',
        '--output-dir', outputDir,
        '--yes',
      ]);
      const output = `${result.stdout}\n${result.stderr}`;
      assert.strictEqual(result.status, 0, output);
      assert.ok(output.includes('ONE_CLICK_DONE') || output.includes('ONE_CLICK_DONE_WITH_CAVEATS'), output);
      assert.ok(!output.includes('KIMI_API_KEY'), output);
      assert.ok(!output.includes('GITHUB_TOKEN'), output);

      const branchAfter = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repo.path, encoding: 'utf-8' }).stdout.trim();
      assert.strictEqual(branchAfter, 'main', 'safe run should not switch branches');
      const logAfter = spawnSync('git', ['log', '--oneline'], { cwd: repo.path, encoding: 'utf-8' }).stdout.trim();
      assert.ok(!logAfter.includes('ai-orchestrator:'), 'safe run should not create commits');
    } finally {
      repo.cleanup();
      rmSync(outputDir, { recursive: true, force: true });
    }
  });

  it('package.json exposes the one-click alias', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8'));
    assert.strictEqual(pkg.scripts['one-click'], 'tsx src/cli.ts autopilot-one-click');
    assert.strictEqual(pkg.scripts['doctor'], 'tsx src/cli.ts doctor');
  });

  it('accepts a JSON mission file', () => {
    const repo = createTempGitRepo();
    const missionPath = join(tmpdir(), `mission-${Date.now()}.json`);
    const outputDir = mkdtempSync(join(tmpdir(), 'one-click-report-'));
    writeFileSync(missionPath, JSON.stringify({
      run_id: `mission-test-${Date.now()}`,
      repo_slug: 'owner/repo',
      repo_path: repo.path,
      base_branch: 'main',
      goal: 'Add a documentation note from JSON mission',
      mode: 'fake',
      capabilities: {
        allow_real_provider: false,
        allow_repo_apply: false,
        allow_repo_commit: false,
        allow_repo_push: false,
        allow_pr_create: false,
        allow_pr_update: false,
        allow_actions_read: false,
        allow_repair: false,
      },
      output_dir: outputDir,
    }), 'utf-8');
    try {
      const result = runOneClick([missionPath, '--yes']);
      const output = `${result.stdout}\n${result.stderr}`;
      assert.strictEqual(result.status, 0, output);
      assert.ok(output.includes('ONE_CLICK_DONE') || output.includes('ONE_CLICK_DONE_WITH_CAVEATS'), output);
    } finally {
      rmSync(missionPath, { force: true });
      rmSync(outputDir, { recursive: true, force: true });
      repo.cleanup();
    }
  });
});

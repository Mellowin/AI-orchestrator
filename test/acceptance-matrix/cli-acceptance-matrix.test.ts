import { describe, test, before } from 'node:test';
import assert from 'node:assert';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import type { AcceptanceMatrixConfig } from '../../src/acceptance-matrix/types.js';

let counter = 0;

function createTempGitRepo(): { path: string; cleanup: () => void } {
  const id = `${Date.now()}-${counter++}`;
  const tmpBase = join(process.cwd(), 'tmp');
  if (!existsSync(tmpBase)) {
    mkdirSync(tmpBase);
  }
  const repoPath = mkdtempSync(join(tmpBase, `am-cli-repo-${id}-`));
  const originPath = mkdtempSync(join(tmpBase, `am-cli-origin-${id}-`));

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

describe('acceptance-matrix CLI', () => {
  before(() => {
    process.env.ALLOW_REAL_BLOCK_RUN_AI = 'true';
    process.env.ALLOW_REAL_PROVIDER = 'true';
    process.env.ALLOW_REAL_REPO_APPLY = 'true';
    process.env.ALLOW_REAL_REPO_COMMIT = 'true';
    process.env.ALLOW_REAL_REPO_PUSH = 'true';
    process.env.KIMI_API_KEY = 'sk-fake-key-for-cli-test';
    process.env.KIMI_BASE_URL = 'https://api.moonshot.ai/v1';
    process.env.KIMI_MODEL = 'kimi-k2.6';
  });

  test('runs the actual CLI command with a fake config', () => {
    const repo = createTempGitRepo();
    const reportBase = mkdtempSync(join(process.cwd(), 'tmp', `am-cli-run-${Date.now()}-`));
    try {
      const config: AcceptanceMatrixConfig = {
        provider: 'fake',
        allow_real_provider: false,
        allow_github_pr_create: false,
        allow_real_repo_apply: true,
        allow_real_repo_commit: true,
        allow_real_repo_push: true,
        stop_on_orchestrator_bug: true,
        report_dir: reportBase,
        sandbox_repo_path: repo.path,
        scenarios: [
          {
            type: 'blocked_continue',
            label: 'CLI blocked continue',
            base_branch: 'main',
            work_branch: 'am-cli-blocked-continue',
            unsafe_response_mode: 'fake_deterministic',
          },
        ],
      };

      const configPath = join(reportBase, 'config.json');
      writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');

      const result = spawnSync(
        process.execPath,
        [
          join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs'),
          join(process.cwd(), 'src', 'cli.ts'),
          'acceptance-matrix',
          configPath,
        ],
        {
          cwd: process.cwd(),
          env: process.env,
          encoding: 'utf-8',
          shell: false,
          timeout: 300000,
        }
      );

      const output = `${result.stdout}\n${result.stderr}`;
      assert.strictEqual(
        result.status,
        0,
        `CLI should exit 0, got ${result.status}. Output:\n${output}`
      );
      assert.ok(existsSync(join(reportBase, 'acceptance-matrix-result.json')));
      assert.ok(existsSync(join(reportBase, 'acceptance-matrix-report.md')));

      const jsonRaw = readFileSync(join(reportBase, 'acceptance-matrix-result.json'), 'utf-8');
      const json = JSON.parse(jsonRaw) as { summary: { passed: number } };
      assert.strictEqual(json.summary.passed, 1);

      assert.ok(!output.includes('sk-fake-key-for-cli-test'));
      assert.ok(!jsonRaw.includes(repo.path));
    } finally {
      repo.cleanup();
      rmSync(reportBase, { recursive: true, force: true });
    }
  });
});

import { describe, test, before } from 'node:test';
import assert from 'node:assert';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { runAcceptanceMatrix } from '../../src/acceptance-matrix/runner.js';
import { writeAcceptanceMatrixReports } from '../../src/acceptance-matrix/report-writer.js';
import type { AcceptanceMatrixConfig } from '../../src/acceptance-matrix/types.js';

let counter = 0;

function createTempGitRepo(): { path: string; cleanup: () => void } {
  const id = `${Date.now()}-${counter++}`;
  const tmpBase = join(process.cwd(), 'tmp');
  if (!existsSync(tmpBase)) {
    mkdirSync(tmpBase);
  }
  const repoPath = mkdtempSync(join(tmpBase, `am-repo-${id}-`));
  const originPath = mkdtempSync(join(tmpBase, `am-origin-${id}-`));

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

describe('acceptance-matrix runner integration', () => {
  before(() => {
    // Ensure the orchestrator can run the block in fake mode.
    process.env.ALLOW_REAL_BLOCK_RUN_AI = 'true';
    process.env.ALLOW_REAL_PROVIDER = 'true';
    process.env.ALLOW_REAL_REPO_APPLY = 'true';
    process.env.ALLOW_REAL_REPO_COMMIT = 'true';
    process.env.ALLOW_REAL_REPO_PUSH = 'true';
    process.env.KIMI_API_KEY = 'sk-fake-key-for-test';
    process.env.KIMI_BASE_URL = 'https://api.moonshot.ai/v1';
    process.env.KIMI_MODEL = 'kimi-k2.6';
  });

  test('runs the full fake acceptance matrix', async () => {
    const repo = createTempGitRepo();
    const reportBase = mkdtempSync(join(process.cwd(), 'tmp', `am-run-${Date.now()}-`));
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
            type: 'golden_real_multitask',
            label: 'Golden multi-task PR',
            base_branch: 'main',
            work_branch: 'am-golden',
            unsafe_response_mode: 'none',
          },
          {
            type: 'blocked_stop',
            label: 'Blocked stop',
            base_branch: 'main',
            work_branch: 'am-blocked-stop',
            unsafe_response_mode: 'fake_deterministic',
          },
          {
            type: 'blocked_continue',
            label: 'Blocked continue',
            base_branch: 'main',
            work_branch: 'am-blocked-continue',
            unsafe_response_mode: 'fake_deterministic',
          },
        ],
      };

      const result = await runAcceptanceMatrix(config);
      writeAcceptanceMatrixReports(result);

      assert.strictEqual(result.summary.total, 3);
      assert.strictEqual(result.summary.passed, 3);
      assert.strictEqual(result.summary.failed, 0);
      assert.strictEqual(result.summary.skipped, 0);

      const golden = result.results.find((r) => r.type === 'golden_real_multitask');
      assert.ok(golden);
      assert.strictEqual(golden?.status, 'passed');
      assert.strictEqual(golden?.expected, true);
      assert.ok((golden?.commit_count_ahead ?? 0) > 0, 'golden scenario should produce commits ahead of base');

      // Verify stdout/stderr were redacted and do not contain the fake key.
      const goldenDir = golden?.evidence_dir ?? '';
      const stdout = readFileSync(join(goldenDir, 'stdout.txt'), 'utf-8');
      const stderr = readFileSync(join(goldenDir, 'stderr.txt'), 'utf-8');
      assert.ok(!stdout.includes('sk-fake-key-for-test'));
      assert.ok(!stderr.includes('sk-fake-key-for-test'));

      const blockedStop = result.results.find((r) => r.type === 'blocked_stop');
      assert.ok(blockedStop);
      assert.strictEqual(blockedStop?.status, 'passed');
      assert.strictEqual(
        blockedStop?.classification,
        'SAFETY_POLICY_BLOCK_EXPECTED_WITH_FAKE_UNSAFE_RESPONSE'
      );

      const blockedContinue = result.results.find((r) => r.type === 'blocked_continue');
      assert.ok(blockedContinue);
      assert.strictEqual(blockedContinue?.status, 'passed');
      assert.strictEqual(
        blockedContinue?.classification,
        'SAFETY_POLICY_BLOCK_EXPECTED_WITH_FAKE_UNSAFE_RESPONSE'
      );
      assert.ok(blockedContinue?.resume, 'blocked_continue should have resume no-op evidence');
      assert.strictEqual(blockedContinue?.resume?.exit_code, 0);
      assert.strictEqual(
        blockedContinue?.resume?.commit_count_ahead_before,
        blockedContinue?.resume?.commit_count_ahead_after
      );
      assert.strictEqual(blockedContinue?.resume?.provider_rerun, false);
      assert.strictEqual(blockedContinue?.resume?.completed_noop_marker_found, true);
      assert.strictEqual(
        blockedContinue?.resume?.provider_attempts_before,
        blockedContinue?.resume?.provider_attempts_after,
        'provider attempts should not increase after resume no-op'
      );

      // Verify resume stdout contains the completed-noop marker.
      const blockedContinueDir = blockedContinue?.evidence_dir ?? '';
      const resumeStdout = readFileSync(join(blockedContinueDir, 'resume-stdout.txt'), 'utf-8');
      const resumeStderr = readFileSync(join(blockedContinueDir, 'resume-stderr.txt'), 'utf-8');
      assert.ok(
        resumeStdout.includes('Resume mode: block already completed.') ||
          resumeStderr.includes('Resume mode: block already completed.'),
        'resume output should contain the completed-noop marker'
      );

      assert.ok(existsSync(join(reportBase, 'acceptance-matrix-result.json')));
      assert.ok(existsSync(join(reportBase, 'acceptance-matrix-report.md')));
    } finally {
      repo.cleanup();
      rmSync(reportBase, { recursive: true, force: true });
    }
  });

  test('skips real provider when not allowed', async () => {
    const repo = createTempGitRepo();
    const reportBase = mkdtempSync(join(process.cwd(), 'tmp', `am-skip-${Date.now()}-`));
    try {
      const config: AcceptanceMatrixConfig = {
        provider: 'kimi',
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
            type: 'golden_real_multitask',
            label: 'Skipped',
            base_branch: 'main',
            work_branch: 'am-skipped',
            unsafe_response_mode: 'none',
          },
        ],
      };

      const result = await runAcceptanceMatrix(config);
      assert.strictEqual(result.results[0].status, 'skipped');
      assert.ok(result.results[0].reason.includes('Real provider not allowed'));
    } finally {
      repo.cleanup();
      rmSync(reportBase, { recursive: true, force: true });
    }
  });

  test('supports a configured base branch other than main', async () => {
    const repo = createTempGitRepo();
    const reportBase = mkdtempSync(join(process.cwd(), 'tmp', `am-dev-${Date.now()}-`));
    try {
      // Create a 'develop' base branch in the sandbox.
      const git = (args: string[]) => {
        const result = spawnSync('git', args, { cwd: repo.path, encoding: 'utf-8', shell: false });
        if (result.status !== 0) {
          throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
        }
      };
      git(['checkout', '-b', 'develop']);
      writeFileSync(join(repo.path, 'develop.md'), '# Develop\n', 'utf-8');
      git(['add', 'develop.md']);
      git(['commit', '-m', 'develop base']);
      git(['push', '-u', 'origin', 'develop']);

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
            type: 'golden_real_multitask',
            label: 'Golden on develop',
            base_branch: 'develop',
            work_branch: 'am-golden-develop',
            unsafe_response_mode: 'none',
          },
        ],
      };

      const result = await runAcceptanceMatrix(config);
      assert.strictEqual(result.summary.total, 1);
      assert.strictEqual(result.summary.passed, 1);
      assert.strictEqual(result.summary.failed, 0);

      const golden = result.results[0];
      assert.strictEqual(golden.status, 'passed');
      assert.ok((golden.commit_count_ahead ?? 0) > 0, 'scenario on develop base should produce commits ahead');
    } finally {
      repo.cleanup();
      rmSync(reportBase, { recursive: true, force: true });
    }
  });
});

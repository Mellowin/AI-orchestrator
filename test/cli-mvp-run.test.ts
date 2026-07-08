import { describe, test, before, after } from 'node:test';
import assert from 'node:assert';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { loadMvpRunConfig, runMvpRun, validateMvpRunConfig } from '../src/mvp-run/index.js';
import type { MvpRunConfig } from '../src/mvp-run/types.js';

let counter = 0;

function createTempGitRepo(): { path: string; cleanup: () => void } {
  const id = `${Date.now()}-${counter++}`;
  const tmpBase = join(process.cwd(), 'tmp');
  if (!existsSync(tmpBase)) {
    mkdirSync(tmpBase);
  }
  const repoPath = mkdtempSync(join(tmpBase, `mvp-run-repo-${id}-`));
  const originPath = mkdtempSync(join(tmpBase, `mvp-run-origin-${id}-`));

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

function baseConfig(repoPath: string, runId: string): MvpRunConfig {
  return {
    provider: 'fake',
    repo_path: repoPath,
    repo_slug: 'Mellowin/ai-orchestrator-sandbox',
    base_branch: 'main',
    work_branch: `mvp-run-${runId}`,
    run_id: runId,
    allow_real_provider: false,
    allow_real_repo_apply: true,
    allow_real_repo_commit: true,
    allow_real_repo_push: true,
    allow_github_pr_create: false,
    tasks: [
      {
        id: 'task_1',
        title: 'Update README',
        goal: 'Update README.md with a short MVP run note.',
        allowed_files: ['README.md'],
        denied_files: ['.env'],
        tests: [],
      },
      {
        id: 'task_2',
        title: 'Add feature note',
        goal: 'Create feature.txt with a short feature note. Modify only feature.txt.',
        allowed_files: ['feature.txt'],
        denied_files: ['.env'],
        tests: [],
      },
    ],
    report_dir: mkdtempSync(join(process.cwd(), 'tmp', `mvp-run-reports-${runId}-`)),
  };
}

describe('mvp-run config validation', () => {
  test('accepts a valid config', () => {
    const result = validateMvpRunConfig({
      provider: 'fake',
      repo_path: 'tmp/repo',
      repo_slug: 'owner/repo',
      base_branch: 'main',
      work_branch: 'mvp-run',
      run_id: 'test',
      allow_real_provider: false,
      allow_real_repo_apply: false,
      allow_real_repo_commit: false,
      allow_real_repo_push: false,
      allow_github_pr_create: false,
      tasks: [{ id: 't1', title: 'T1', goal: 'g', allowed_files: ['a.txt'] }],
      report_dir: 'reports',
    });
    assert.strictEqual(result.ok, true);
  });

  test('rejects missing tasks', () => {
    const result = validateMvpRunConfig({
      provider: 'fake',
      repo_path: 'tmp/repo',
      base_branch: 'main',
      work_branch: 'mvp-run',
      run_id: 'test',
      allow_real_provider: false,
      allow_real_repo_apply: false,
      allow_real_repo_commit: false,
      allow_real_repo_push: false,
      allow_github_pr_create: false,
      tasks: [],
      report_dir: 'reports',
    });
    assert.strictEqual(result.ok, false);
    assert.ok(result.reasons.some((r) => r.includes('tasks must be a non-empty array')));
  });

  test('rejects protected work branch', () => {
    const result = validateMvpRunConfig({
      provider: 'fake',
      repo_path: 'tmp/repo',
      base_branch: 'main',
      work_branch: 'main',
      run_id: 'test',
      allow_real_provider: false,
      allow_real_repo_apply: false,
      allow_real_repo_commit: false,
      allow_real_repo_push: false,
      allow_github_pr_create: false,
      tasks: [{ id: 't1', title: 'T1', goal: 'g', allowed_files: ['a.txt'] }],
      report_dir: 'reports',
    });
    assert.strictEqual(result.ok, false);
    assert.ok(result.reasons.some((r) => r.includes('work_branch must not be a protected branch')));
  });

  test('loadMvpRunConfig resolves paths', () => {
    const tmpBase = mkdtempSync(join(process.cwd(), 'tmp', `mvp-run-cfg-${Date.now()}-`));
    const configPath = join(tmpBase, 'config.json');
    const config: MvpRunConfig = {
      provider: 'fake',
      repo_path: 'tmp/repo',
      base_branch: 'main',
      work_branch: 'mvp-run',
      run_id: 'test',
      allow_real_provider: false,
      allow_real_repo_apply: false,
      allow_real_repo_commit: false,
      allow_real_repo_push: false,
      allow_github_pr_create: false,
      tasks: [{ id: 't1', title: 'T1', goal: 'g', allowed_files: ['a.txt'] }],
      report_dir: 'reports',
    };
    writeFileSync(configPath, JSON.stringify(config), 'utf-8');
    const loaded = loadMvpRunConfig(configPath);
    assert.ok(loaded.repo_path.startsWith(process.cwd()));
    assert.ok(loaded.report_dir.startsWith(process.cwd()));
    rmSync(tmpBase, { recursive: true, force: true });
  });
});

const originalEnvSnapshot: Record<string, string | undefined> = {};

function snapshotEnvKey(key: string): void {
  originalEnvSnapshot[key] = process.env[key];
}

function restoreEnvSnapshot(): void {
  for (const [key, value] of Object.entries(originalEnvSnapshot)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

describe('mvp-run product flow', () => {
  before(() => {
    const envKeys = [
      'ALLOW_REAL_BLOCK_RUN_AI',
      'ALLOW_REAL_PROVIDER',
      'ALLOW_REAL_REPO_APPLY',
      'ALLOW_REAL_REPO_COMMIT',
      'ALLOW_REAL_REPO_PUSH',
      'KIMI_API_KEY',
      'KIMI_BASE_URL',
      'KIMI_MODEL',
    ];
    for (const key of envKeys) {
      snapshotEnvKey(key);
    }

    process.env.ALLOW_REAL_BLOCK_RUN_AI = 'true';
    process.env.ALLOW_REAL_PROVIDER = 'true';
    process.env.ALLOW_REAL_REPO_APPLY = 'true';
    process.env.ALLOW_REAL_REPO_COMMIT = 'true';
    process.env.ALLOW_REAL_REPO_PUSH = 'true';
    // Fake MVP runs use KIMI_FAKE_RESPONSES with a mocked fetch, but the
    // underlying real-repo-run-ai path still validates that these vars exist.
    // Set dummy values so tests are isolated from the local .env file.
    process.env.KIMI_API_KEY = 'fake-key';
    process.env.KIMI_BASE_URL = 'https://api.moonshot.cn/v1';
    process.env.KIMI_MODEL = 'kimi-k2.6';
  });

  after(() => {
    restoreEnvSnapshot();
  });

  test('fake mvp-run with 2 tasks passes', async () => {
    const repo = createTempGitRepo();
    const runId = `fake-pass-${Date.now()}`;
    const config = baseConfig(repo.path, runId);
    try {
      const result = await runMvpRun(config, join(config.report_dir, 'config.json'));
      assert.strictEqual(result.verdict, 'MVP_RUN_PASSED');
      assert.strictEqual(result.tasks_passed, 2);
      assert.strictEqual(result.tasks_total, 2);
      assert.ok(result.commits.length >= 2, `expected at least 2 commits, got ${result.commits.length}`);
      assert.strictEqual(result.pushed, true);
    } finally {
      repo.cleanup();
      rmSync(config.report_dir, { recursive: true, force: true });
    }
  });

  test('report files are written', async () => {
    const repo = createTempGitRepo();
    const runId = `reports-${Date.now()}`;
    const config = baseConfig(repo.path, runId);
    try {
      const result = await runMvpRun(config, join(config.report_dir, 'config.json'));
      const reportDir = result.report_dir;
      assert.ok(existsSync(join(reportDir, 'report.md')));
      assert.ok(existsSync(join(reportDir, 'report.json')));
      assert.ok(existsSync(join(reportDir, 'block.json')));

      const jsonRaw = readFileSync(join(reportDir, 'report.json'), 'utf-8');
      const json = JSON.parse(jsonRaw) as { verdict: string; config: { repo_path: string } };
      assert.strictEqual(json.verdict, 'MVP_RUN_PASSED');
      assert.strictEqual(json.config.repo_path, '[REDACTED]');
    } finally {
      repo.cleanup();
      rmSync(config.report_dir, { recursive: true, force: true });
    }
  });

  test('resume does not rerun completed tasks', async () => {
    const repo = createTempGitRepo();
    const runId = `resume-${Date.now()}`;
    const config = baseConfig(repo.path, runId);
    const configPath = join(config.report_dir, 'config.json');
    try {
      const first = await runMvpRun(config, configPath);
      assert.strictEqual(first.verdict, 'MVP_RUN_PASSED');
      const commitsBefore = first.commits.length;
      const providerAttemptsBefore = first.task_results.reduce((sum, t) => sum + t.provider_attempts, 0);

      const second = await runMvpRun(config, configPath, { resume: true });
      assert.strictEqual(second.verdict, 'MVP_RUN_PASSED');
      assert.strictEqual(second.commits.length, commitsBefore, 'resume should not create new commits');
      const providerAttemptsAfter = second.task_results.reduce((sum, t) => sum + t.provider_attempts, 0);
      assert.strictEqual(providerAttemptsAfter, providerAttemptsBefore, 'resume should not rerun provider');
    } finally {
      repo.cleanup();
      rmSync(config.report_dir, { recursive: true, force: true });
    }
  });

  test('missing real provider env fails before execution', async () => {
    const repo = createTempGitRepo();
    const runId = `missing-env-${Date.now()}`;
    const config: MvpRunConfig = {
      ...baseConfig(repo.path, runId),
      provider: 'kimi',
      allow_real_provider: true,
      allow_real_repo_apply: false,
      allow_real_repo_commit: false,
      allow_real_repo_push: false,
    };
    try {
      const result = await runMvpRun(config, join(config.report_dir, 'config.json'));
      assert.strictEqual(result.verdict, 'MVP_RUN_FAILED');
      assert.strictEqual(result.classification, 'CONFIG_ERROR');
      assert.ok(result.reason.includes('ALLOW_REAL_PROVIDER_RUN'));
      assert.strictEqual(result.commits.length, 0);
    } finally {
      repo.cleanup();
      rmSync(config.report_dir, { recursive: true, force: true });
    }
  });

  test('PR creation disabled is reported as not attempted', async () => {
    const repo = createTempGitRepo();
    const runId = `no-pr-${Date.now()}`;
    const config = baseConfig(repo.path, runId);
    try {
      const result = await runMvpRun(config, join(config.report_dir, 'config.json'));
      assert.strictEqual(result.verdict, 'MVP_RUN_PASSED');
      assert.ok(result.pr);
      assert.strictEqual(result.pr?.created, false);
      assert.ok(result.pr?.reason.includes('not attempted'));
      assert.ok(!result.caveats.some((c) => c.toLowerCase().includes('failed')));
    } finally {
      repo.cleanup();
      rmSync(config.report_dir, { recursive: true, force: true });
    }
  });
});

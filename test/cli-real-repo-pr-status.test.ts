import { describe, test } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

let counter = 0;

function getCleanEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.AI_PROVIDER;
  delete env.MOCK_AI_RESPONSE;
  delete env.MOCK_REVIEWER_RESPONSE;
  delete env.MOCK_PROVIDER_RESPONSE;
  env.KIMI_API_KEY = '';
  delete env.KIMI_MODEL;
  env.KIMI_BASE_URL = '';
  delete env.KIMI_USER_AGENT;
  delete env.KIMI_FAKE_RESPONSE;
  delete env.KIMI_FAKE_RESPONSES;
  delete env.OPENAI_API_KEY;
  delete env.MOCK_AI;
  delete env.ALLOW_REAL_PROVIDER_RUN;
  delete env.ALLOW_REAL_PROVIDER;
  delete env.ALLOW_SANDBOX_APPLY_PREVIEW;
  delete env.ALLOW_REAL_REPO_APPLY;
  delete env.ALLOW_REAL_REPO_COMMIT;
  delete env.ALLOW_REAL_REPO_PUSH;
  delete env.ALLOW_REAL_REPO_APPROVAL_REPORT;
  delete env.ALLOW_REAL_REPO_PR_READINESS;
  delete env.ALLOW_GITHUB_PR_CREATE;
  delete env.ALLOW_GITHUB_PR_STATUS;
  env.GITHUB_TOKEN = '';
  env.GITHUB_REPOSITORY = '';
  delete env.GITHUB_API_BASE_URL;
  delete env.GITHUB_FAKE_PR_RESPONSE;
  delete env.GITHUB_FAKE_STATUS_RESPONSE;
  delete env.GITHUB_FAKE_CHECKS_RESPONSE;
  delete env.GITHUB_FAKE_PR_STATUS;
  delete env.SANDBOX_PROVIDER_RESPONSE;
  delete env.SANDBOX_ROOT;
  delete env.REAL_REPO_PROVIDER_RESPONSE;
  delete env.RUNS_DIR;
  delete env.REAL_REPO_AI_MAX_ATTEMPTS;
  delete env.REAL_REPO_REVIEWER_FAKE_RESPONSE;
  delete env.KIMI_FAKE_REVIEWER_RESPONSE;
  delete env.REAL_REPO_REVIEWER_NO_DEFAULT;
  env.AI_PROVIDER = 'mock';
  return env;
}

function runCli(
  args: string[],
  envOverrides: Record<string, string> = {}
): {
  status: number;
  stdout: string;
  stderr: string;
} {
  const env = { ...getCleanEnv(), ...envOverrides };
  if (
    !env.REAL_REPO_REVIEWER_FAKE_RESPONSE &&
    !env.KIMI_FAKE_REVIEWER_RESPONSE &&
    env.REAL_REPO_REVIEWER_NO_DEFAULT !== '1' &&
    (env.ALLOW_REAL_PROVIDER === 'true' || env.ALLOW_REAL_PROVIDER === '1')
  ) {
    env.REAL_REPO_REVIEWER_FAKE_RESPONSE = JSON.stringify({
      decision: 'accept',
      confidence: 'high',
      blockingIssues: [],
      nonBlockingIssues: [],
      reviewSummary: 'Default test reviewer acceptance.',
      nextAction: 'continue',
    });
  }
  const result = spawnSync(
    `npx tsx "${join(process.cwd(), 'src', 'cli.ts')}" ${args.join(' ')}`,
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

function createTempEnv(opts?: {
  withState?: boolean;
  withReports?: boolean;
  withPrCreated?: boolean;
  stateOverrides?: Record<string, unknown>;
  prCreatedOverrides?: Record<string, unknown>;
}): {
  taskId: string;
  tasksFilePath: string;
  repoPath: string;
  runsDir: string;
  cleanup: () => void;
} {
  const id = `${Date.now()}-${counter++}`;
  const taskId = `prs-r-${id}`;
  const tmpBase = join(process.cwd(), 'tmp');
  if (!existsSync(tmpBase)) {
    mkdirSync(tmpBase);
  }
  const tmpDir = mkdtempSync(join(tmpBase, `prs-r-${id}-`));
  const repoPath = join(tmpDir, 'repo');
  const runsDir = join(tmpDir, 'runs');
  mkdirSync(repoPath);

  writeFileSync(join(repoPath, 'README.md'), '# hello\n', 'utf-8');

  spawnSync('git', ['init'], {
    cwd: repoPath,
    encoding: 'utf-8',
    shell: false,
  });
  spawnSync('git', ['config', 'user.email', 'ci@example.com'], {
    cwd: repoPath,
    encoding: 'utf-8',
    shell: false,
  });
  spawnSync('git', ['config', 'user.name', 'CI User'], {
    cwd: repoPath,
    encoding: 'utf-8',
    shell: false,
  });
  spawnSync('git', ['add', '.'], {
    cwd: repoPath,
    encoding: 'utf-8',
    shell: false,
  });
  spawnSync('git', ['commit', '-m', 'init', '--no-gpg-sign'], {
    cwd: repoPath,
    encoding: 'utf-8',
    shell: false,
  });
  spawnSync('git', ['branch', '-m', 'main'], {
    cwd: repoPath,
    encoding: 'utf-8',
    shell: false,
  });

  const workBranch = `ai/${taskId}`;
  spawnSync('git', ['checkout', '-b', workBranch], {
    cwd: repoPath,
    encoding: 'utf-8',
    shell: false,
  });

  writeFileSync(join(repoPath, 'change.txt'), 'changed\n', 'utf-8');
  spawnSync('git', ['add', '.'], {
    cwd: repoPath,
    encoding: 'utf-8',
    shell: false,
  });
  spawnSync('git', ['commit', '-m', 'change', '--no-gpg-sign'], {
    cwd: repoPath,
    encoding: 'utf-8',
    shell: false,
  });

  const tasksFilePath = join(tmpDir, 'tasks.yaml');
  writeFileSync(
    tasksFilePath,
    `tasks:
  - id: ${taskId}
    title: "PR status test"
    repo_path: "${repoPath.replace(/\\/g, '/')}"
    base_branch: "main"
    work_branch: "${workBranch}"
    goal: "Test goal"
    context_files: []
    checks:
      - command: "node"
        args: ["-e", "process.exit(0)"]
    guardrails:
      deny_modify:
        - ".env"
        - ".env.*"
        - "node_modules/**"
      max_lines_changed: 150
      require_tests: false
      auto_commit: false
      auto_push: false
      auto_merge: false
`,
    'utf-8'
  );

  let commitSha = '';
  if (opts?.withState || opts?.withPrCreated) {
    commitSha = spawnSync('git', ['rev-parse', 'HEAD'], {
      cwd: repoPath,
      encoding: 'utf-8',
      shell: false,
    }).stdout.trim();
  }

  if (opts?.withState) {
    mkdirSync(join(runsDir, taskId), { recursive: true });
    const state = {
      task_id: taskId,
      status: 'pushed',
      current_attempt: 0,
      branch: workBranch,
      repo_path: repoPath,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      pushed_remote: 'origin',
      pushed_ref: workBranch,
      commit_sha: commitSha,
      safety_note: 'Push completed; merge not performed; human review required before merge',
      ...opts.stateOverrides,
    };
    writeFileSync(join(runsDir, taskId, 'state.json'), JSON.stringify(state, null, 2), 'utf-8');
  }

  if (opts?.withReports || opts?.withPrCreated) {
    mkdirSync(join(runsDir, taskId), { recursive: true });
    writeFileSync(join(runsDir, taskId, 'approval-report.md'), '# Approval report\n', 'utf-8');
    writeFileSync(join(runsDir, taskId, 'pr-readiness.md'), '# PR Readiness\n', 'utf-8');
    writeFileSync(join(runsDir, taskId, 'pr-body.md'), `## Task\n- **Task ID:** ${taskId}\n- **Goal:** Test goal\n`, 'utf-8');
  }

  if (opts?.withPrCreated) {
    mkdirSync(join(runsDir, taskId), { recursive: true });
    const prCreated = {
      task_id: taskId,
      pr_number: 42,
      pr_url: `https://github.com/test-owner/test-repo/pull/42`,
      base: 'main',
      head: workBranch,
      commit_sha: commitSha,
      created_at: new Date().toISOString(),
      safety_note: 'PR created; merge not performed; human review required before merge',
      ...opts.prCreatedOverrides,
    };
    writeFileSync(join(runsDir, taskId, 'pr-created.json'), JSON.stringify(prCreated, null, 2), 'utf-8');
  }

  return {
    taskId,
    tasksFilePath,
    repoPath,
    runsDir,
    cleanup: () => {
      rmSync(tmpDir, { recursive: true, force: true });
    },
  };
}

function fakePrJson(): string {
  return JSON.stringify({
    number: 42,
    html_url: 'https://github.com/test-owner/test-repo/pull/42',
    state: 'open',
    draft: false,
    title: 'PR status test',
    user: { login: 'test-user' },
    mergeable: true,
    mergeable_state: 'clean',
  });
}

function fakeStatusJson(): string {
  return JSON.stringify({
    state: 'success',
    total_count: 2,
    statuses: [
      { context: 'ci/build', state: 'success', description: 'Build passed' },
      { context: 'ci/test', state: 'success', description: 'Tests passed' },
    ],
  });
}

function fakeChecksJson(): string {
  return JSON.stringify({
    total_count: 1,
    check_runs: [
      { name: 'CI', status: 'completed', conclusion: 'success', html_url: 'https://github.com/test-owner/test-repo/checks/1' },
    ],
  });
}

describe('cli real-repo-pr-status', () => {
  test('missing taskId refuses', () => {
    const result = runCli(['real-repo-pr-status']);
    assert.notStrictEqual(result.status, 0);
    assert(result.stderr.includes('task id is required'), `Expected task id required: ${result.stderr}`);
  });

  test('missing ALLOW_GITHUB_PR_STATUS refuses before API call', () => {
    const { taskId, tasksFilePath, cleanup } = createTempEnv();
    try {
      const result = runCli(['real-repo-pr-status', taskId], {
        TASKS_FILE: tasksFilePath,
      });
      assert.notStrictEqual(result.status, 0);
      assert(result.stderr.includes('ALLOW_GITHUB_PR_STATUS=true is required'), `Expected opt-in required: ${result.stderr}`);
    } finally {
      cleanup();
    }
  });

  test('missing GITHUB_TOKEN refuses before API call', () => {
    const { taskId, tasksFilePath, cleanup } = createTempEnv();
    try {
      const result = runCli(['real-repo-pr-status', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_GITHUB_PR_STATUS: 'true',
      });
      assert.notStrictEqual(result.status, 0);
      assert(result.stderr.includes('GITHUB_TOKEN is required'), `Expected token required: ${result.stderr}`);
    } finally {
      cleanup();
    }
  });

  test('missing GITHUB_REPOSITORY refuses before API call', () => {
    const { taskId, tasksFilePath, cleanup } = createTempEnv();
    try {
      const result = runCli(['real-repo-pr-status', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_GITHUB_PR_STATUS: 'true',
        GITHUB_TOKEN: 'fake-token',
      });
      assert.notStrictEqual(result.status, 0);
      assert(result.stderr.includes('GITHUB_REPOSITORY is required'), `Expected repo required: ${result.stderr}`);
    } finally {
      cleanup();
    }
  });

  test('invalid GITHUB_REPOSITORY refuses before API call', () => {
    const { taskId, tasksFilePath, cleanup } = createTempEnv();
    try {
      const result = runCli(['real-repo-pr-status', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_GITHUB_PR_STATUS: 'true',
        GITHUB_TOKEN: 'fake-token',
        GITHUB_REPOSITORY: 'invalid-repo-format',
      });
      assert.notStrictEqual(result.status, 0);
      assert(result.stderr.includes('owner/repo format'), `Expected invalid repo: ${result.stderr}`);
    } finally {
      cleanup();
    }
  });

  test('missing task refuses before API call', () => {
    const { tasksFilePath, cleanup } = createTempEnv();
    try {
      const result = runCli(['real-repo-pr-status', 'nonexistent-task'], {
        TASKS_FILE: tasksFilePath,
        ALLOW_GITHUB_PR_STATUS: 'true',
        GITHUB_TOKEN: 'fake-token',
        GITHUB_REPOSITORY: 'test-owner/test-repo',
      });
      assert.notStrictEqual(result.status, 0);
      assert(result.stderr.includes('not found') || result.stderr.includes('Error:'), `Expected error: ${result.stderr}`);
    } finally {
      cleanup();
    }
  });

  test('missing repo_path refuses before API call', () => {
    const { taskId, tasksFilePath, cleanup } = createTempEnv();
    try {
      const content = readFileSync(tasksFilePath, 'utf-8');
      writeFileSync(tasksFilePath, content.replace(/repo_path: "[^"]+"/, 'repo_path: "/nonexistent/path"'), 'utf-8');
      const result = runCli(['real-repo-pr-status', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_GITHUB_PR_STATUS: 'true',
        GITHUB_TOKEN: 'fake-token',
        GITHUB_REPOSITORY: 'test-owner/test-repo',
      });
      assert.notStrictEqual(result.status, 0);
      assert(result.stderr.includes('repo_path does not exist'), `Expected repo_path error: ${result.stderr}`);
    } finally {
      cleanup();
    }
  });

  test('missing base_branch refuses before API call', () => {
    const { taskId, tasksFilePath, cleanup } = createTempEnv();
    try {
      const content = readFileSync(tasksFilePath, 'utf-8');
      writeFileSync(tasksFilePath, content.replace('base_branch: "main"', 'base_branch: ""'), 'utf-8');
      const result = runCli(['real-repo-pr-status', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_GITHUB_PR_STATUS: 'true',
        GITHUB_TOKEN: 'fake-token',
        GITHUB_REPOSITORY: 'test-owner/test-repo',
      });
      assert.notStrictEqual(result.status, 0);
      assert(result.stderr.includes('base_branch is missing'), `Expected base_branch missing: ${result.stderr}`);
    } finally {
      cleanup();
    }
  });

  test('missing work_branch refuses before API call', () => {
    const { taskId, tasksFilePath, cleanup } = createTempEnv();
    try {
      const content = readFileSync(tasksFilePath, 'utf-8');
      writeFileSync(tasksFilePath, content.replace(`work_branch: "ai/${taskId}"`, 'work_branch: ""'), 'utf-8');
      const result = runCli(['real-repo-pr-status', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_GITHUB_PR_STATUS: 'true',
        GITHUB_TOKEN: 'fake-token',
        GITHUB_REPOSITORY: 'test-owner/test-repo',
      });
      assert.notStrictEqual(result.status, 0);
      assert(result.stderr.includes('work_branch is missing'), `Expected work_branch missing: ${result.stderr}`);
    } finally {
      cleanup();
    }
  });

  test('work_branch main refuses before API call', () => {
    const { taskId, tasksFilePath, cleanup } = createTempEnv();
    try {
      const content = readFileSync(tasksFilePath, 'utf-8');
      writeFileSync(tasksFilePath, content.replace(`work_branch: "ai/${taskId}"`, 'work_branch: "main"'), 'utf-8');
      const result = runCli(['real-repo-pr-status', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_GITHUB_PR_STATUS: 'true',
        GITHUB_TOKEN: 'fake-token',
        GITHUB_REPOSITORY: 'test-owner/test-repo',
      });
      assert.notStrictEqual(result.status, 0);
      assert(result.stderr.includes('work_branch is main'), `Expected work_branch main: ${result.stderr}`);
    } finally {
      cleanup();
    }
  });

  test('missing state refuses before API call', () => {
    const { taskId, tasksFilePath, cleanup } = createTempEnv();
    try {
      const result = runCli(['real-repo-pr-status', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_GITHUB_PR_STATUS: 'true',
        GITHUB_TOKEN: 'fake-token',
        GITHUB_REPOSITORY: 'test-owner/test-repo',
      });
      assert.notStrictEqual(result.status, 0);
      assert(result.stderr.includes('State file does not exist'), `Expected missing state: ${result.stderr}`);
    } finally {
      cleanup();
    }
  });

  test('state status not pushed refuses before API call', () => {
    const { taskId, tasksFilePath, runsDir, cleanup } = createTempEnv({ withState: true, stateOverrides: { status: 'reviewing' } });
    try {
      const result = runCli(['real-repo-pr-status', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_GITHUB_PR_STATUS: 'true',
        GITHUB_TOKEN: 'fake-token',
        GITHUB_REPOSITORY: 'test-owner/test-repo',
        RUNS_DIR: runsDir,
      });
      assert.notStrictEqual(result.status, 0);
      assert(result.stderr.includes('expected "pushed"'), `Expected pushed status: ${result.stderr}`);
    } finally {
      cleanup();
    }
  });

  test('state task_id mismatch refuses before API call', () => {
    const { taskId, tasksFilePath, runsDir, cleanup } = createTempEnv({ withState: true, stateOverrides: { task_id: 'other-task' } });
    try {
      const result = runCli(['real-repo-pr-status', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_GITHUB_PR_STATUS: 'true',
        GITHUB_TOKEN: 'fake-token',
        GITHUB_REPOSITORY: 'test-owner/test-repo',
        RUNS_DIR: runsDir,
      });
      assert.notStrictEqual(result.status, 0);
      assert(result.stderr.includes('task_id mismatch'), `Expected task_id mismatch: ${result.stderr}`);
    } finally {
      cleanup();
    }
  });

  test('state branch mismatch refuses before API call', () => {
    const { taskId, tasksFilePath, runsDir, cleanup } = createTempEnv({ withState: true, stateOverrides: { branch: 'other-branch' } });
    try {
      const result = runCli(['real-repo-pr-status', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_GITHUB_PR_STATUS: 'true',
        GITHUB_TOKEN: 'fake-token',
        GITHUB_REPOSITORY: 'test-owner/test-repo',
        RUNS_DIR: runsDir,
      });
      assert.notStrictEqual(result.status, 0);
      assert(result.stderr.includes('State branch mismatch'), `Expected branch mismatch: ${result.stderr}`);
    } finally {
      cleanup();
    }
  });

  test('state pushed_remote not origin refuses before API call', () => {
    const { taskId, tasksFilePath, runsDir, cleanup } = createTempEnv({ withState: true, stateOverrides: { pushed_remote: 'upstream' } });
    try {
      const result = runCli(['real-repo-pr-status', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_GITHUB_PR_STATUS: 'true',
        GITHUB_TOKEN: 'fake-token',
        GITHUB_REPOSITORY: 'test-owner/test-repo',
        RUNS_DIR: runsDir,
      });
      assert.notStrictEqual(result.status, 0);
      assert(result.stderr.includes('pushed_remote is not origin'), `Expected not origin: ${result.stderr}`);
    } finally {
      cleanup();
    }
  });

  test('state pushed_ref mismatch refuses before API call', () => {
    const { taskId, tasksFilePath, runsDir, cleanup } = createTempEnv({ withState: true, stateOverrides: { pushed_ref: 'other-branch' } });
    try {
      const result = runCli(['real-repo-pr-status', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_GITHUB_PR_STATUS: 'true',
        GITHUB_TOKEN: 'fake-token',
        GITHUB_REPOSITORY: 'test-owner/test-repo',
        RUNS_DIR: runsDir,
      });
      assert.notStrictEqual(result.status, 0);
      assert(result.stderr.includes('pushed_ref mismatch'), `Expected pushed_ref mismatch: ${result.stderr}`);
    } finally {
      cleanup();
    }
  });

  test('missing commit_sha refuses before API call', () => {
    const { taskId, tasksFilePath, runsDir, cleanup } = createTempEnv({ withState: true, stateOverrides: { commit_sha: '' } });
    try {
      const result = runCli(['real-repo-pr-status', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_GITHUB_PR_STATUS: 'true',
        GITHUB_TOKEN: 'fake-token',
        GITHUB_REPOSITORY: 'test-owner/test-repo',
        RUNS_DIR: runsDir,
      });
      assert.notStrictEqual(result.status, 0);
      assert(result.stderr.includes('commit_sha is missing'), `Expected missing commit_sha: ${result.stderr}`);
    } finally {
      cleanup();
    }
  });

  test('unknown commit_sha refuses before API call', () => {
    const badSha = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const { taskId, tasksFilePath, runsDir, cleanup } = createTempEnv({
      withState: true,
      withReports: true,
      withPrCreated: true,
      stateOverrides: { commit_sha: badSha },
      prCreatedOverrides: { commit_sha: badSha },
    });
    try {
      const result = runCli(['real-repo-pr-status', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_GITHUB_PR_STATUS: 'true',
        GITHUB_TOKEN: 'fake-token',
        GITHUB_REPOSITORY: 'test-owner/test-repo',
        RUNS_DIR: runsDir,
      });
      assert.notStrictEqual(result.status, 0);
      assert(result.stderr.includes('Commit SHA does not exist'), `Expected unknown commit: ${result.stderr}`);
    } finally {
      cleanup();
    }
  });

  test('missing approval-report.md refuses before API call', () => {
    const { taskId, tasksFilePath, runsDir, cleanup } = createTempEnv({ withState: true });
    try {
      mkdirSync(join(runsDir, taskId), { recursive: true });
      writeFileSync(join(runsDir, taskId, 'pr-readiness.md'), '# PR Readiness\n', 'utf-8');
      writeFileSync(join(runsDir, taskId, 'pr-body.md'), 'body\n', 'utf-8');
      writeFileSync(join(runsDir, taskId, 'pr-created.json'), '{}', 'utf-8');
      const result = runCli(['real-repo-pr-status', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_GITHUB_PR_STATUS: 'true',
        GITHUB_TOKEN: 'fake-token',
        GITHUB_REPOSITORY: 'test-owner/test-repo',
        RUNS_DIR: runsDir,
      });
      assert.notStrictEqual(result.status, 0);
      assert(result.stderr.includes('Approval report is required'), `Expected approval report required: ${result.stderr}`);
    } finally {
      cleanup();
    }
  });

  test('missing pr-readiness.md refuses before API call', () => {
    const { taskId, tasksFilePath, runsDir, cleanup } = createTempEnv({ withState: true });
    try {
      mkdirSync(join(runsDir, taskId), { recursive: true });
      writeFileSync(join(runsDir, taskId, 'approval-report.md'), '# Approval report\n', 'utf-8');
      writeFileSync(join(runsDir, taskId, 'pr-body.md'), 'body\n', 'utf-8');
      writeFileSync(join(runsDir, taskId, 'pr-created.json'), '{}', 'utf-8');
      const result = runCli(['real-repo-pr-status', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_GITHUB_PR_STATUS: 'true',
        GITHUB_TOKEN: 'fake-token',
        GITHUB_REPOSITORY: 'test-owner/test-repo',
        RUNS_DIR: runsDir,
      });
      assert.notStrictEqual(result.status, 0);
      assert(result.stderr.includes('PR readiness report is required'), `Expected pr-readiness required: ${result.stderr}`);
    } finally {
      cleanup();
    }
  });

  test('missing pr-body.md refuses before API call', () => {
    const { taskId, tasksFilePath, runsDir, cleanup } = createTempEnv({ withState: true });
    try {
      mkdirSync(join(runsDir, taskId), { recursive: true });
      writeFileSync(join(runsDir, taskId, 'approval-report.md'), '# Approval report\n', 'utf-8');
      writeFileSync(join(runsDir, taskId, 'pr-readiness.md'), '# PR Readiness\n', 'utf-8');
      writeFileSync(join(runsDir, taskId, 'pr-created.json'), '{}', 'utf-8');
      const result = runCli(['real-repo-pr-status', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_GITHUB_PR_STATUS: 'true',
        GITHUB_TOKEN: 'fake-token',
        GITHUB_REPOSITORY: 'test-owner/test-repo',
        RUNS_DIR: runsDir,
      });
      assert.notStrictEqual(result.status, 0);
      assert(result.stderr.includes('PR body is required'), `Expected pr-body required: ${result.stderr}`);
    } finally {
      cleanup();
    }
  });

  test('missing pr-created.json refuses before API call', () => {
    const { taskId, tasksFilePath, runsDir, cleanup } = createTempEnv({ withState: true, withReports: true });
    try {
      const result = runCli(['real-repo-pr-status', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_GITHUB_PR_STATUS: 'true',
        GITHUB_TOKEN: 'fake-token',
        GITHUB_REPOSITORY: 'test-owner/test-repo',
        RUNS_DIR: runsDir,
      });
      assert.notStrictEqual(result.status, 0);
      assert(result.stderr.includes('pr-created.json is required'), `Expected pr-created required: ${result.stderr}`);
    } finally {
      cleanup();
    }
  });

  test('invalid pr-created task_id refuses before API call', () => {
    const { taskId, tasksFilePath, runsDir, cleanup } = createTempEnv({ withState: true, withReports: true, withPrCreated: true, prCreatedOverrides: { task_id: 'wrong-task' } });
    try {
      const result = runCli(['real-repo-pr-status', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_GITHUB_PR_STATUS: 'true',
        GITHUB_TOKEN: 'fake-token',
        GITHUB_REPOSITORY: 'test-owner/test-repo',
        RUNS_DIR: runsDir,
      });
      assert.notStrictEqual(result.status, 0);
      assert(result.stderr.includes('pr-created.json task_id mismatch'), `Expected task_id mismatch: ${result.stderr}`);
    } finally {
      cleanup();
    }
  });

  test('invalid pr-created pr_number refuses before API call', () => {
    const { taskId, tasksFilePath, runsDir, cleanup } = createTempEnv({ withState: true, withReports: true, withPrCreated: true, prCreatedOverrides: { pr_number: -1 } });
    try {
      const result = runCli(['real-repo-pr-status', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_GITHUB_PR_STATUS: 'true',
        GITHUB_TOKEN: 'fake-token',
        GITHUB_REPOSITORY: 'test-owner/test-repo',
        RUNS_DIR: runsDir,
      });
      assert.notStrictEqual(result.status, 0);
      assert(result.stderr.includes('pr_number is invalid'), `Expected pr_number invalid: ${result.stderr}`);
    } finally {
      cleanup();
    }
  });

  test('invalid pr-created base/head refuses before API call', () => {
    const { taskId, tasksFilePath, runsDir, cleanup } = createTempEnv({ withState: true, withReports: true, withPrCreated: true, prCreatedOverrides: { base: 'wrong-base' } });
    try {
      const result = runCli(['real-repo-pr-status', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_GITHUB_PR_STATUS: 'true',
        GITHUB_TOKEN: 'fake-token',
        GITHUB_REPOSITORY: 'test-owner/test-repo',
        RUNS_DIR: runsDir,
      });
      assert.notStrictEqual(result.status, 0);
      assert(result.stderr.includes('base branch mismatch'), `Expected base mismatch: ${result.stderr}`);
    } finally {
      cleanup();
    }
  });

  test('invalid pr-created commit_sha refuses before API call', () => {
    const { taskId, tasksFilePath, runsDir, cleanup } = createTempEnv({ withState: true, withReports: true, withPrCreated: true, prCreatedOverrides: { commit_sha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' } });
    try {
      const result = runCli(['real-repo-pr-status', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_GITHUB_PR_STATUS: 'true',
        GITHUB_TOKEN: 'fake-token',
        GITHUB_REPOSITORY: 'test-owner/test-repo',
        RUNS_DIR: runsDir,
      });
      assert.notStrictEqual(result.status, 0);
      assert(result.stderr.includes('commit_sha mismatch'), `Expected commit_sha mismatch: ${result.stderr}`);
    } finally {
      cleanup();
    }
  });

  test('valid setup calls GitHub API for PR exactly once', () => {
    const { taskId, tasksFilePath, runsDir, cleanup } = createTempEnv({ withState: true, withReports: true, withPrCreated: true });
    try {
      const result = runCli(['real-repo-pr-status', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_GITHUB_PR_STATUS: 'true',
        GITHUB_TOKEN: 'fake-token',
        GITHUB_REPOSITORY: 'test-owner/test-repo',
        GITHUB_FAKE_PR_RESPONSE: fakePrJson(),
        GITHUB_FAKE_STATUS_RESPONSE: fakeStatusJson(),
        GITHUB_FAKE_CHECKS_RESPONSE: fakeChecksJson(),
        RUNS_DIR: runsDir,
      });
      assert.strictEqual(result.status, 0, `Expected success: ${result.stderr}`);
      const prMatches = result.stderr.match(/\[github-api-request\] GET.+\/pulls\/42/g);
      assert(prMatches && prMatches.length === 1, `Expected exactly one PR API call: ${result.stderr}`);
    } finally {
      cleanup();
    }
  });

  test('valid setup calls GitHub API for combined status exactly once', () => {
    const { taskId, tasksFilePath, runsDir, cleanup } = createTempEnv({ withState: true, withReports: true, withPrCreated: true });
    try {
      const result = runCli(['real-repo-pr-status', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_GITHUB_PR_STATUS: 'true',
        GITHUB_TOKEN: 'fake-token',
        GITHUB_REPOSITORY: 'test-owner/test-repo',
        GITHUB_FAKE_PR_RESPONSE: fakePrJson(),
        GITHUB_FAKE_STATUS_RESPONSE: fakeStatusJson(),
        GITHUB_FAKE_CHECKS_RESPONSE: fakeChecksJson(),
        RUNS_DIR: runsDir,
      });
      assert.strictEqual(result.status, 0, `Expected success: ${result.stderr}`);
      const statusMatches = result.stderr.match(/\[github-api-request\] GET.+\/status/g);
      assert(statusMatches && statusMatches.length === 1, `Expected exactly one status API call: ${result.stderr}`);
    } finally {
      cleanup();
    }
  });

  test('calls check-runs exactly once', () => {
    const { taskId, tasksFilePath, runsDir, cleanup } = createTempEnv({ withState: true, withReports: true, withPrCreated: true });
    try {
      const result = runCli(['real-repo-pr-status', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_GITHUB_PR_STATUS: 'true',
        GITHUB_TOKEN: 'fake-token',
        GITHUB_REPOSITORY: 'test-owner/test-repo',
        GITHUB_FAKE_PR_RESPONSE: fakePrJson(),
        GITHUB_FAKE_STATUS_RESPONSE: fakeStatusJson(),
        GITHUB_FAKE_CHECKS_RESPONSE: fakeChecksJson(),
        RUNS_DIR: runsDir,
      });
      assert.strictEqual(result.status, 0, `Expected success: ${result.stderr}`);
      const checksMatches = result.stderr.match(/\[github-api-request\] GET.+\/check-runs/g);
      assert(checksMatches && checksMatches.length === 1, `Expected exactly one check-runs API call: ${result.stderr}`);
    } finally {
      cleanup();
    }
  });

  test('API calls use GET', () => {
    const { taskId, tasksFilePath, runsDir, cleanup } = createTempEnv({ withState: true, withReports: true, withPrCreated: true });
    try {
      const result = runCli(['real-repo-pr-status', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_GITHUB_PR_STATUS: 'true',
        GITHUB_TOKEN: 'fake-token',
        GITHUB_REPOSITORY: 'test-owner/test-repo',
        GITHUB_FAKE_PR_RESPONSE: fakePrJson(),
        GITHUB_FAKE_STATUS_RESPONSE: fakeStatusJson(),
        GITHUB_FAKE_CHECKS_RESPONSE: fakeChecksJson(),
        RUNS_DIR: runsDir,
      });
      assert.strictEqual(result.status, 0, `Expected success: ${result.stderr}`);
      const getMatches = result.stderr.match(/\[github-api-request\] GET/g);
      assert(getMatches && getMatches.length === 3, `Expected 3 GET requests: ${result.stderr}`);
    } finally {
      cleanup();
    }
  });

  test('API URLs use GITHUB_REPOSITORY', () => {
    const { taskId, tasksFilePath, runsDir, cleanup } = createTempEnv({ withState: true, withReports: true, withPrCreated: true });
    try {
      const result = runCli(['real-repo-pr-status', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_GITHUB_PR_STATUS: 'true',
        GITHUB_TOKEN: 'fake-token',
        GITHUB_REPOSITORY: 'test-owner/test-repo',
        GITHUB_FAKE_PR_RESPONSE: fakePrJson(),
        GITHUB_FAKE_STATUS_RESPONSE: fakeStatusJson(),
        GITHUB_FAKE_CHECKS_RESPONSE: fakeChecksJson(),
        RUNS_DIR: runsDir,
      });
      assert.strictEqual(result.status, 0, `Expected success: ${result.stderr}`);
      assert(result.stderr.includes('/repos/test-owner/test-repo/'), `Expected repo in URLs: ${result.stderr}`);
    } finally {
      cleanup();
    }
  });

  test('success writes pr-status-report.md', () => {
    const { taskId, tasksFilePath, runsDir, cleanup } = createTempEnv({ withState: true, withReports: true, withPrCreated: true });
    try {
      const result = runCli(['real-repo-pr-status', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_GITHUB_PR_STATUS: 'true',
        GITHUB_TOKEN: 'fake-token',
        GITHUB_REPOSITORY: 'test-owner/test-repo',
        GITHUB_FAKE_PR_RESPONSE: fakePrJson(),
        GITHUB_FAKE_STATUS_RESPONSE: fakeStatusJson(),
        GITHUB_FAKE_CHECKS_RESPONSE: fakeChecksJson(),
        RUNS_DIR: runsDir,
      });
      assert.strictEqual(result.status, 0, `Expected success: ${result.stderr}`);
      assert(existsSync(join(runsDir, taskId, 'pr-status-report.md')), `Expected pr-status-report.md`);
    } finally {
      cleanup();
    }
  });

  test('success writes pr-status.json', () => {
    const { taskId, tasksFilePath, runsDir, cleanup } = createTempEnv({ withState: true, withReports: true, withPrCreated: true });
    try {
      const result = runCli(['real-repo-pr-status', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_GITHUB_PR_STATUS: 'true',
        GITHUB_TOKEN: 'fake-token',
        GITHUB_REPOSITORY: 'test-owner/test-repo',
        GITHUB_FAKE_PR_RESPONSE: fakePrJson(),
        GITHUB_FAKE_STATUS_RESPONSE: fakeStatusJson(),
        GITHUB_FAKE_CHECKS_RESPONSE: fakeChecksJson(),
        RUNS_DIR: runsDir,
      });
      assert.strictEqual(result.status, 0, `Expected success: ${result.stderr}`);
      assert(existsSync(join(runsDir, taskId, 'pr-status.json')), `Expected pr-status.json`);
    } finally {
      cleanup();
    }
  });

  test('report contains task id', () => {
    const { taskId, tasksFilePath, runsDir, cleanup } = createTempEnv({ withState: true, withReports: true, withPrCreated: true });
    try {
      runCli(['real-repo-pr-status', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_GITHUB_PR_STATUS: 'true',
        GITHUB_TOKEN: 'fake-token',
        GITHUB_REPOSITORY: 'test-owner/test-repo',
        GITHUB_FAKE_PR_RESPONSE: fakePrJson(),
        GITHUB_FAKE_STATUS_RESPONSE: fakeStatusJson(),
        GITHUB_FAKE_CHECKS_RESPONSE: fakeChecksJson(),
        RUNS_DIR: runsDir,
      });
      const report = readFileSync(join(runsDir, taskId, 'pr-status-report.md'), 'utf-8');
      assert(report.includes(taskId), `Expected task id in report`);
    } finally {
      cleanup();
    }
  });

  test('report contains PR number', () => {
    const { taskId, tasksFilePath, runsDir, cleanup } = createTempEnv({ withState: true, withReports: true, withPrCreated: true });
    try {
      runCli(['real-repo-pr-status', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_GITHUB_PR_STATUS: 'true',
        GITHUB_TOKEN: 'fake-token',
        GITHUB_REPOSITORY: 'test-owner/test-repo',
        GITHUB_FAKE_PR_RESPONSE: fakePrJson(),
        GITHUB_FAKE_STATUS_RESPONSE: fakeStatusJson(),
        GITHUB_FAKE_CHECKS_RESPONSE: fakeChecksJson(),
        RUNS_DIR: runsDir,
      });
      const report = readFileSync(join(runsDir, taskId, 'pr-status-report.md'), 'utf-8');
      assert(report.includes('42'), `Expected PR number in report`);
    } finally {
      cleanup();
    }
  });

  test('report contains PR URL', () => {
    const { taskId, tasksFilePath, runsDir, cleanup } = createTempEnv({ withState: true, withReports: true, withPrCreated: true });
    try {
      runCli(['real-repo-pr-status', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_GITHUB_PR_STATUS: 'true',
        GITHUB_TOKEN: 'fake-token',
        GITHUB_REPOSITORY: 'test-owner/test-repo',
        GITHUB_FAKE_PR_RESPONSE: fakePrJson(),
        GITHUB_FAKE_STATUS_RESPONSE: fakeStatusJson(),
        GITHUB_FAKE_CHECKS_RESPONSE: fakeChecksJson(),
        RUNS_DIR: runsDir,
      });
      const report = readFileSync(join(runsDir, taskId, 'pr-status-report.md'), 'utf-8');
      assert(report.includes('https://github.com/test-owner/test-repo/pull/42'), `Expected PR URL in report`);
    } finally {
      cleanup();
    }
  });

  test('report contains PR state', () => {
    const { taskId, tasksFilePath, runsDir, cleanup } = createTempEnv({ withState: true, withReports: true, withPrCreated: true });
    try {
      runCli(['real-repo-pr-status', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_GITHUB_PR_STATUS: 'true',
        GITHUB_TOKEN: 'fake-token',
        GITHUB_REPOSITORY: 'test-owner/test-repo',
        GITHUB_FAKE_PR_RESPONSE: fakePrJson(),
        GITHUB_FAKE_STATUS_RESPONSE: fakeStatusJson(),
        GITHUB_FAKE_CHECKS_RESPONSE: fakeChecksJson(),
        RUNS_DIR: runsDir,
      });
      const report = readFileSync(join(runsDir, taskId, 'pr-status-report.md'), 'utf-8');
      assert(report.includes('open'), `Expected PR state in report`);
    } finally {
      cleanup();
    }
  });

  test('report contains base branch', () => {
    const { taskId, tasksFilePath, runsDir, cleanup } = createTempEnv({ withState: true, withReports: true, withPrCreated: true });
    try {
      runCli(['real-repo-pr-status', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_GITHUB_PR_STATUS: 'true',
        GITHUB_TOKEN: 'fake-token',
        GITHUB_REPOSITORY: 'test-owner/test-repo',
        GITHUB_FAKE_PR_RESPONSE: fakePrJson(),
        GITHUB_FAKE_STATUS_RESPONSE: fakeStatusJson(),
        GITHUB_FAKE_CHECKS_RESPONSE: fakeChecksJson(),
        RUNS_DIR: runsDir,
      });
      const report = readFileSync(join(runsDir, taskId, 'pr-status-report.md'), 'utf-8');
      assert(report.includes('main'), `Expected base branch in report`);
    } finally {
      cleanup();
    }
  });

  test('report contains head branch', () => {
    const { taskId, tasksFilePath, runsDir, cleanup } = createTempEnv({ withState: true, withReports: true, withPrCreated: true });
    try {
      runCli(['real-repo-pr-status', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_GITHUB_PR_STATUS: 'true',
        GITHUB_TOKEN: 'fake-token',
        GITHUB_REPOSITORY: 'test-owner/test-repo',
        GITHUB_FAKE_PR_RESPONSE: fakePrJson(),
        GITHUB_FAKE_STATUS_RESPONSE: fakeStatusJson(),
        GITHUB_FAKE_CHECKS_RESPONSE: fakeChecksJson(),
        RUNS_DIR: runsDir,
      });
      const report = readFileSync(join(runsDir, taskId, 'pr-status-report.md'), 'utf-8');
      assert(report.includes(`ai/${taskId}`), `Expected head branch in report`);
    } finally {
      cleanup();
    }
  });

  test('report contains pushed commit SHA', () => {
    const { taskId, tasksFilePath, runsDir, cleanup } = createTempEnv({ withState: true, withReports: true, withPrCreated: true });
    try {
      runCli(['real-repo-pr-status', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_GITHUB_PR_STATUS: 'true',
        GITHUB_TOKEN: 'fake-token',
        GITHUB_REPOSITORY: 'test-owner/test-repo',
        GITHUB_FAKE_PR_RESPONSE: fakePrJson(),
        GITHUB_FAKE_STATUS_RESPONSE: fakeStatusJson(),
        GITHUB_FAKE_CHECKS_RESPONSE: fakeChecksJson(),
        RUNS_DIR: runsDir,
      });
      const state = JSON.parse(readFileSync(join(runsDir, taskId, 'state.json'), 'utf-8'));
      const report = readFileSync(join(runsDir, taskId, 'pr-status-report.md'), 'utf-8');
      assert(report.includes(state.commit_sha), `Expected commit SHA in report`);
    } finally {
      cleanup();
    }
  });

  test('report contains combined status state', () => {
    const { taskId, tasksFilePath, runsDir, cleanup } = createTempEnv({ withState: true, withReports: true, withPrCreated: true });
    try {
      runCli(['real-repo-pr-status', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_GITHUB_PR_STATUS: 'true',
        GITHUB_TOKEN: 'fake-token',
        GITHUB_REPOSITORY: 'test-owner/test-repo',
        GITHUB_FAKE_PR_RESPONSE: fakePrJson(),
        GITHUB_FAKE_STATUS_RESPONSE: fakeStatusJson(),
        GITHUB_FAKE_CHECKS_RESPONSE: fakeChecksJson(),
        RUNS_DIR: runsDir,
      });
      const report = readFileSync(join(runsDir, taskId, 'pr-status-report.md'), 'utf-8');
      assert(report.includes('success'), `Expected combined status state in report`);
    } finally {
      cleanup();
    }
  });

  test('report contains status/check summary', () => {
    const { taskId, tasksFilePath, runsDir, cleanup } = createTempEnv({ withState: true, withReports: true, withPrCreated: true });
    try {
      runCli(['real-repo-pr-status', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_GITHUB_PR_STATUS: 'true',
        GITHUB_TOKEN: 'fake-token',
        GITHUB_REPOSITORY: 'test-owner/test-repo',
        GITHUB_FAKE_PR_RESPONSE: fakePrJson(),
        GITHUB_FAKE_STATUS_RESPONSE: fakeStatusJson(),
        GITHUB_FAKE_CHECKS_RESPONSE: fakeChecksJson(),
        RUNS_DIR: runsDir,
      });
      const report = readFileSync(join(runsDir, taskId, 'pr-status-report.md'), 'utf-8');
      assert(report.includes('ci/build'), `Expected status context in report`);
      assert(report.includes('CI'), `Expected check run name in report`);
    } finally {
      cleanup();
    }
  });

  test('pr-status.json contains task_id', () => {
    const { taskId, tasksFilePath, runsDir, cleanup } = createTempEnv({ withState: true, withReports: true, withPrCreated: true });
    try {
      runCli(['real-repo-pr-status', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_GITHUB_PR_STATUS: 'true',
        GITHUB_TOKEN: 'fake-token',
        GITHUB_REPOSITORY: 'test-owner/test-repo',
        GITHUB_FAKE_PR_RESPONSE: fakePrJson(),
        GITHUB_FAKE_STATUS_RESPONSE: fakeStatusJson(),
        GITHUB_FAKE_CHECKS_RESPONSE: fakeChecksJson(),
        RUNS_DIR: runsDir,
      });
      const data = JSON.parse(readFileSync(join(runsDir, taskId, 'pr-status.json'), 'utf-8'));
      assert.strictEqual(data.task_id, taskId, `Expected task_id`);
    } finally {
      cleanup();
    }
  });

  test('pr-status.json contains pr_number', () => {
    const { taskId, tasksFilePath, runsDir, cleanup } = createTempEnv({ withState: true, withReports: true, withPrCreated: true });
    try {
      runCli(['real-repo-pr-status', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_GITHUB_PR_STATUS: 'true',
        GITHUB_TOKEN: 'fake-token',
        GITHUB_REPOSITORY: 'test-owner/test-repo',
        GITHUB_FAKE_PR_RESPONSE: fakePrJson(),
        GITHUB_FAKE_STATUS_RESPONSE: fakeStatusJson(),
        GITHUB_FAKE_CHECKS_RESPONSE: fakeChecksJson(),
        RUNS_DIR: runsDir,
      });
      const data = JSON.parse(readFileSync(join(runsDir, taskId, 'pr-status.json'), 'utf-8'));
      assert.strictEqual(data.pr_number, 42, `Expected pr_number`);
    } finally {
      cleanup();
    }
  });

  test('pr-status.json contains pr_url', () => {
    const { taskId, tasksFilePath, runsDir, cleanup } = createTempEnv({ withState: true, withReports: true, withPrCreated: true });
    try {
      runCli(['real-repo-pr-status', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_GITHUB_PR_STATUS: 'true',
        GITHUB_TOKEN: 'fake-token',
        GITHUB_REPOSITORY: 'test-owner/test-repo',
        GITHUB_FAKE_PR_RESPONSE: fakePrJson(),
        GITHUB_FAKE_STATUS_RESPONSE: fakeStatusJson(),
        GITHUB_FAKE_CHECKS_RESPONSE: fakeChecksJson(),
        RUNS_DIR: runsDir,
      });
      const data = JSON.parse(readFileSync(join(runsDir, taskId, 'pr-status.json'), 'utf-8'));
      assert.strictEqual(data.pr_url, 'https://github.com/test-owner/test-repo/pull/42', `Expected pr_url`);
    } finally {
      cleanup();
    }
  });

  test('pr-status.json contains pr_state', () => {
    const { taskId, tasksFilePath, runsDir, cleanup } = createTempEnv({ withState: true, withReports: true, withPrCreated: true });
    try {
      runCli(['real-repo-pr-status', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_GITHUB_PR_STATUS: 'true',
        GITHUB_TOKEN: 'fake-token',
        GITHUB_REPOSITORY: 'test-owner/test-repo',
        GITHUB_FAKE_PR_RESPONSE: fakePrJson(),
        GITHUB_FAKE_STATUS_RESPONSE: fakeStatusJson(),
        GITHUB_FAKE_CHECKS_RESPONSE: fakeChecksJson(),
        RUNS_DIR: runsDir,
      });
      const data = JSON.parse(readFileSync(join(runsDir, taskId, 'pr-status.json'), 'utf-8'));
      assert.strictEqual(data.pr_state, 'open', `Expected pr_state`);
    } finally {
      cleanup();
    }
  });

  test('pr-status.json contains base/head', () => {
    const { taskId, tasksFilePath, runsDir, cleanup } = createTempEnv({ withState: true, withReports: true, withPrCreated: true });
    try {
      runCli(['real-repo-pr-status', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_GITHUB_PR_STATUS: 'true',
        GITHUB_TOKEN: 'fake-token',
        GITHUB_REPOSITORY: 'test-owner/test-repo',
        GITHUB_FAKE_PR_RESPONSE: fakePrJson(),
        GITHUB_FAKE_STATUS_RESPONSE: fakeStatusJson(),
        GITHUB_FAKE_CHECKS_RESPONSE: fakeChecksJson(),
        RUNS_DIR: runsDir,
      });
      const data = JSON.parse(readFileSync(join(runsDir, taskId, 'pr-status.json'), 'utf-8'));
      assert.strictEqual(data.base, 'main', `Expected base`);
      assert(data.head.includes(taskId), `Expected head`);
    } finally {
      cleanup();
    }
  });

  test('pr-status.json contains commit_sha', () => {
    const { taskId, tasksFilePath, runsDir, cleanup } = createTempEnv({ withState: true, withReports: true, withPrCreated: true });
    try {
      runCli(['real-repo-pr-status', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_GITHUB_PR_STATUS: 'true',
        GITHUB_TOKEN: 'fake-token',
        GITHUB_REPOSITORY: 'test-owner/test-repo',
        GITHUB_FAKE_PR_RESPONSE: fakePrJson(),
        GITHUB_FAKE_STATUS_RESPONSE: fakeStatusJson(),
        GITHUB_FAKE_CHECKS_RESPONSE: fakeChecksJson(),
        RUNS_DIR: runsDir,
      });
      const state = JSON.parse(readFileSync(join(runsDir, taskId, 'state.json'), 'utf-8'));
      const data = JSON.parse(readFileSync(join(runsDir, taskId, 'pr-status.json'), 'utf-8'));
      assert.strictEqual(data.commit_sha, state.commit_sha, `Expected commit_sha`);
    } finally {
      cleanup();
    }
  });

  test('pr-status.json contains combined_status_state', () => {
    const { taskId, tasksFilePath, runsDir, cleanup } = createTempEnv({ withState: true, withReports: true, withPrCreated: true });
    try {
      runCli(['real-repo-pr-status', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_GITHUB_PR_STATUS: 'true',
        GITHUB_TOKEN: 'fake-token',
        GITHUB_REPOSITORY: 'test-owner/test-repo',
        GITHUB_FAKE_PR_RESPONSE: fakePrJson(),
        GITHUB_FAKE_STATUS_RESPONSE: fakeStatusJson(),
        GITHUB_FAKE_CHECKS_RESPONSE: fakeChecksJson(),
        RUNS_DIR: runsDir,
      });
      const data = JSON.parse(readFileSync(join(runsDir, taskId, 'pr-status.json'), 'utf-8'));
      assert.strictEqual(data.combined_status_state, 'success', `Expected combined_status_state`);
    } finally {
      cleanup();
    }
  });

  test('report says no PR created', () => {
    const { taskId, tasksFilePath, runsDir, cleanup } = createTempEnv({ withState: true, withReports: true, withPrCreated: true });
    try {
      runCli(['real-repo-pr-status', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_GITHUB_PR_STATUS: 'true',
        GITHUB_TOKEN: 'fake-token',
        GITHUB_REPOSITORY: 'test-owner/test-repo',
        GITHUB_FAKE_PR_RESPONSE: fakePrJson(),
        GITHUB_FAKE_STATUS_RESPONSE: fakeStatusJson(),
        GITHUB_FAKE_CHECKS_RESPONSE: fakeChecksJson(),
        RUNS_DIR: runsDir,
      });
      const report = readFileSync(join(runsDir, taskId, 'pr-status-report.md'), 'utf-8');
      assert(report.includes('This tool did not create a PR'), `Expected no PR created statement`);
    } finally {
      cleanup();
    }
  });

  test('report says no PR updated', () => {
    const { taskId, tasksFilePath, runsDir, cleanup } = createTempEnv({ withState: true, withReports: true, withPrCreated: true });
    try {
      runCli(['real-repo-pr-status', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_GITHUB_PR_STATUS: 'true',
        GITHUB_TOKEN: 'fake-token',
        GITHUB_REPOSITORY: 'test-owner/test-repo',
        GITHUB_FAKE_PR_RESPONSE: fakePrJson(),
        GITHUB_FAKE_STATUS_RESPONSE: fakeStatusJson(),
        GITHUB_FAKE_CHECKS_RESPONSE: fakeChecksJson(),
        RUNS_DIR: runsDir,
      });
      const report = readFileSync(join(runsDir, taskId, 'pr-status-report.md'), 'utf-8');
      assert(report.includes('This tool did not update a PR'), `Expected no PR updated statement`);
    } finally {
      cleanup();
    }
  });

  test('report says no merge', () => {
    const { taskId, tasksFilePath, runsDir, cleanup } = createTempEnv({ withState: true, withReports: true, withPrCreated: true });
    try {
      runCli(['real-repo-pr-status', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_GITHUB_PR_STATUS: 'true',
        GITHUB_TOKEN: 'fake-token',
        GITHUB_REPOSITORY: 'test-owner/test-repo',
        GITHUB_FAKE_PR_RESPONSE: fakePrJson(),
        GITHUB_FAKE_STATUS_RESPONSE: fakeStatusJson(),
        GITHUB_FAKE_CHECKS_RESPONSE: fakeChecksJson(),
        RUNS_DIR: runsDir,
      });
      const report = readFileSync(join(runsDir, taskId, 'pr-status-report.md'), 'utf-8');
      assert(report.includes('This tool did not merge'), `Expected no merge statement`);
    } finally {
      cleanup();
    }
  });

  test('report says no checkout/switch', () => {
    const { taskId, tasksFilePath, runsDir, cleanup } = createTempEnv({ withState: true, withReports: true, withPrCreated: true });
    try {
      runCli(['real-repo-pr-status', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_GITHUB_PR_STATUS: 'true',
        GITHUB_TOKEN: 'fake-token',
        GITHUB_REPOSITORY: 'test-owner/test-repo',
        GITHUB_FAKE_PR_RESPONSE: fakePrJson(),
        GITHUB_FAKE_STATUS_RESPONSE: fakeStatusJson(),
        GITHUB_FAKE_CHECKS_RESPONSE: fakeChecksJson(),
        RUNS_DIR: runsDir,
      });
      const report = readFileSync(join(runsDir, taskId, 'pr-status-report.md'), 'utf-8');
      assert(report.includes('This tool did not checkout or switch branches'), `Expected no checkout statement`);
    } finally {
      cleanup();
    }
  });

  test('report says no main touch', () => {
    const { taskId, tasksFilePath, runsDir, cleanup } = createTempEnv({ withState: true, withReports: true, withPrCreated: true });
    try {
      runCli(['real-repo-pr-status', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_GITHUB_PR_STATUS: 'true',
        GITHUB_TOKEN: 'fake-token',
        GITHUB_REPOSITORY: 'test-owner/test-repo',
        GITHUB_FAKE_PR_RESPONSE: fakePrJson(),
        GITHUB_FAKE_STATUS_RESPONSE: fakeStatusJson(),
        GITHUB_FAKE_CHECKS_RESPONSE: fakeChecksJson(),
        RUNS_DIR: runsDir,
      });
      const report = readFileSync(join(runsDir, taskId, 'pr-status-report.md'), 'utf-8');
      assert(report.includes('This tool did not touch main'), `Expected no main touch statement`);
    } finally {
      cleanup();
    }
  });

  test('report says no push', () => {
    const { taskId, tasksFilePath, runsDir, cleanup } = createTempEnv({ withState: true, withReports: true, withPrCreated: true });
    try {
      runCli(['real-repo-pr-status', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_GITHUB_PR_STATUS: 'true',
        GITHUB_TOKEN: 'fake-token',
        GITHUB_REPOSITORY: 'test-owner/test-repo',
        GITHUB_FAKE_PR_RESPONSE: fakePrJson(),
        GITHUB_FAKE_STATUS_RESPONSE: fakeStatusJson(),
        GITHUB_FAKE_CHECKS_RESPONSE: fakeChecksJson(),
        RUNS_DIR: runsDir,
      });
      const report = readFileSync(join(runsDir, taskId, 'pr-status-report.md'), 'utf-8');
      assert(report.includes('This tool did not push'), `Expected no push statement`);
    } finally {
      cleanup();
    }
  });

  test('report says no provider call', () => {
    const { taskId, tasksFilePath, runsDir, cleanup } = createTempEnv({ withState: true, withReports: true, withPrCreated: true });
    try {
      runCli(['real-repo-pr-status', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_GITHUB_PR_STATUS: 'true',
        GITHUB_TOKEN: 'fake-token',
        GITHUB_REPOSITORY: 'test-owner/test-repo',
        GITHUB_FAKE_PR_RESPONSE: fakePrJson(),
        GITHUB_FAKE_STATUS_RESPONSE: fakeStatusJson(),
        GITHUB_FAKE_CHECKS_RESPONSE: fakeChecksJson(),
        RUNS_DIR: runsDir,
      });
      const report = readFileSync(join(runsDir, taskId, 'pr-status-report.md'), 'utf-8');
      assert(report.includes('This tool did not call provider'), `Expected no provider statement`);
    } finally {
      cleanup();
    }
  });

  test('GitHub API failure writes no report/json', () => {
    const { taskId, tasksFilePath, runsDir, cleanup } = createTempEnv({ withState: true, withReports: true, withPrCreated: true });
    try {
      const result = runCli(['real-repo-pr-status', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_GITHUB_PR_STATUS: 'true',
        GITHUB_TOKEN: 'fake-token',
        GITHUB_REPOSITORY: 'test-owner/test-repo',
        GITHUB_FAKE_PR_RESPONSE: JSON.stringify({ message: 'Not Found' }),
        GITHUB_FAKE_PR_STATUS: '404',
        RUNS_DIR: runsDir,
      });
      assert.notStrictEqual(result.status, 0, `Expected failure: ${result.stderr}`);
      assert(!existsSync(join(runsDir, taskId, 'pr-status-report.md')), `Expected no report`);
      assert(!existsSync(join(runsDir, taskId, 'pr-status.json')), `Expected no json`);
    } finally {
      cleanup();
    }
  });

  test('GitHub API failure prints safe error', () => {
    const { taskId, tasksFilePath, runsDir, cleanup } = createTempEnv({ withState: true, withReports: true, withPrCreated: true });
    try {
      const result = runCli(['real-repo-pr-status', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_GITHUB_PR_STATUS: 'true',
        GITHUB_TOKEN: 'fake-token',
        GITHUB_REPOSITORY: 'test-owner/test-repo',
        GITHUB_FAKE_PR_RESPONSE: JSON.stringify({ message: 'Not Found' }),
        GITHUB_FAKE_PR_STATUS: '404',
        RUNS_DIR: runsDir,
      });
      assert.notStrictEqual(result.status, 0);
      assert(result.stderr.includes('GitHub PR status fetch failed'), `Expected safe error: ${result.stderr}`);
      assert(result.stderr.includes('Manual inspection required'), `Expected manual inspection: ${result.stderr}`);
    } finally {
      cleanup();
    }
  });

  test('token is not printed on success', () => {
    const { taskId, tasksFilePath, runsDir, cleanup } = createTempEnv({ withState: true, withReports: true, withPrCreated: true });
    try {
      const result = runCli(['real-repo-pr-status', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_GITHUB_PR_STATUS: 'true',
        GITHUB_TOKEN: 'ghp_secrettoken12345',
        GITHUB_REPOSITORY: 'test-owner/test-repo',
        GITHUB_FAKE_PR_RESPONSE: fakePrJson(),
        GITHUB_FAKE_STATUS_RESPONSE: fakeStatusJson(),
        GITHUB_FAKE_CHECKS_RESPONSE: fakeChecksJson(),
        RUNS_DIR: runsDir,
      });
      assert.strictEqual(result.status, 0, `Expected success: ${result.stderr}`);
      assert(!result.stderr.includes('ghp_secrettoken12345'), `Stderr must not contain token`);
      assert(!result.stdout.includes('ghp_secrettoken12345'), `Stdout must not contain token`);
    } finally {
      cleanup();
    }
  });

  test('token is not printed on failure', () => {
    const { taskId, tasksFilePath, runsDir, cleanup } = createTempEnv({ withState: true, withReports: true, withPrCreated: true });
    try {
      const result = runCli(['real-repo-pr-status', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_GITHUB_PR_STATUS: 'true',
        GITHUB_TOKEN: 'ghp_secrettoken12345',
        GITHUB_REPOSITORY: 'test-owner/test-repo',
        GITHUB_FAKE_PR_RESPONSE: JSON.stringify({ message: 'Not Found' }),
        GITHUB_FAKE_PR_STATUS: '404',
        RUNS_DIR: runsDir,
      });
      assert.notStrictEqual(result.status, 0);
      assert(!result.stderr.includes('ghp_secrettoken12345'), `Stderr must not contain token on failure`);
      assert(!result.stdout.includes('ghp_secrettoken12345'), `Stdout must not contain token on failure`);
    } finally {
      cleanup();
    }
  });

  test('token is not written to report/json', () => {
    const { taskId, tasksFilePath, runsDir, cleanup } = createTempEnv({ withState: true, withReports: true, withPrCreated: true });
    try {
      runCli(['real-repo-pr-status', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_GITHUB_PR_STATUS: 'true',
        GITHUB_TOKEN: 'ghp_secrettoken12345',
        GITHUB_REPOSITORY: 'test-owner/test-repo',
        GITHUB_FAKE_PR_RESPONSE: fakePrJson(),
        GITHUB_FAKE_STATUS_RESPONSE: fakeStatusJson(),
        GITHUB_FAKE_CHECKS_RESPONSE: fakeChecksJson(),
        RUNS_DIR: runsDir,
      });
      const reportRaw = readFileSync(join(runsDir, taskId, 'pr-status-report.md'), 'utf-8');
      const jsonRaw = readFileSync(join(runsDir, taskId, 'pr-status.json'), 'utf-8');
      assert(!reportRaw.includes('ghp_secrettoken12345'), `Report must not contain token`);
      assert(!jsonRaw.includes('ghp_secrettoken12345'), `JSON must not contain token`);
    } finally {
      cleanup();
    }
  });

  test('remote URL with credentials is not printed', () => {
    const { taskId, tasksFilePath, repoPath, runsDir, cleanup } = createTempEnv({ withState: true, withReports: true, withPrCreated: true });
    try {
      spawnSync('git', ['remote', 'set-url', 'origin', 'https://user:pass@github.com/test/repo.git'], {
        cwd: repoPath,
        encoding: 'utf-8',
        shell: false,
      });
      const result = runCli(['real-repo-pr-status', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_GITHUB_PR_STATUS: 'true',
        GITHUB_TOKEN: 'fake-token',
        GITHUB_REPOSITORY: 'test-owner/test-repo',
        GITHUB_FAKE_PR_RESPONSE: fakePrJson(),
        GITHUB_FAKE_STATUS_RESPONSE: fakeStatusJson(),
        GITHUB_FAKE_CHECKS_RESPONSE: fakeChecksJson(),
        RUNS_DIR: runsDir,
      });
      assert.strictEqual(result.status, 0, `Expected success: ${result.stderr}`);
      assert(!result.stderr.includes('user:pass'), `Stderr must not contain credentials`);
    } finally {
      cleanup();
    }
  });

  test('remote URL with credentials is not written', () => {
    const { taskId, tasksFilePath, repoPath, runsDir, cleanup } = createTempEnv({ withState: true, withReports: true, withPrCreated: true });
    try {
      spawnSync('git', ['remote', 'set-url', 'origin', 'https://user:pass@github.com/test/repo.git'], {
        cwd: repoPath,
        encoding: 'utf-8',
        shell: false,
      });
      runCli(['real-repo-pr-status', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_GITHUB_PR_STATUS: 'true',
        GITHUB_TOKEN: 'fake-token',
        GITHUB_REPOSITORY: 'test-owner/test-repo',
        GITHUB_FAKE_PR_RESPONSE: fakePrJson(),
        GITHUB_FAKE_STATUS_RESPONSE: fakeStatusJson(),
        GITHUB_FAKE_CHECKS_RESPONSE: fakeChecksJson(),
        RUNS_DIR: runsDir,
      });
      const reportRaw = readFileSync(join(runsDir, taskId, 'pr-status-report.md'), 'utf-8');
      const jsonRaw = readFileSync(join(runsDir, taskId, 'pr-status.json'), 'utf-8');
      assert(!reportRaw.includes('user:pass'), `Report must not contain credentials`);
      assert(!jsonRaw.includes('user:pass'), `JSON must not contain credentials`);
    } finally {
      cleanup();
    }
  });

  test('command does not call provider', () => {
    const { taskId, tasksFilePath, runsDir, cleanup } = createTempEnv({ withState: true, withReports: true, withPrCreated: true });
    try {
      const result = runCli(['real-repo-pr-status', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_GITHUB_PR_STATUS: 'true',
        GITHUB_TOKEN: 'fake-token',
        GITHUB_REPOSITORY: 'test-owner/test-repo',
        GITHUB_FAKE_PR_RESPONSE: fakePrJson(),
        GITHUB_FAKE_STATUS_RESPONSE: fakeStatusJson(),
        GITHUB_FAKE_CHECKS_RESPONSE: fakeChecksJson(),
        RUNS_DIR: runsDir,
      });
      assert.strictEqual(result.status, 0, `Expected success: ${result.stderr}`);
    } finally {
      cleanup();
    }
  });

  test('command does not apply files', () => {
    const { taskId, tasksFilePath, repoPath, runsDir, cleanup } = createTempEnv({ withState: true, withReports: true, withPrCreated: true });
    try {
      const before = spawnSync('git', ['status', '--porcelain'], { cwd: repoPath, encoding: 'utf-8', shell: false }).stdout;
      runCli(['real-repo-pr-status', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_GITHUB_PR_STATUS: 'true',
        GITHUB_TOKEN: 'fake-token',
        GITHUB_REPOSITORY: 'test-owner/test-repo',
        GITHUB_FAKE_PR_RESPONSE: fakePrJson(),
        GITHUB_FAKE_STATUS_RESPONSE: fakeStatusJson(),
        GITHUB_FAKE_CHECKS_RESPONSE: fakeChecksJson(),
        RUNS_DIR: runsDir,
      });
      const after = spawnSync('git', ['status', '--porcelain'], { cwd: repoPath, encoding: 'utf-8', shell: false }).stdout;
      assert.strictEqual(before, after, 'Working tree must not change');
    } finally {
      cleanup();
    }
  });

  test('command does not commit', () => {
    const { taskId, tasksFilePath, repoPath, runsDir, cleanup } = createTempEnv({ withState: true, withReports: true, withPrCreated: true });
    try {
      const before = spawnSync('git', ['log', '--oneline'], { cwd: repoPath, encoding: 'utf-8', shell: false }).stdout;
      runCli(['real-repo-pr-status', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_GITHUB_PR_STATUS: 'true',
        GITHUB_TOKEN: 'fake-token',
        GITHUB_REPOSITORY: 'test-owner/test-repo',
        GITHUB_FAKE_PR_RESPONSE: fakePrJson(),
        GITHUB_FAKE_STATUS_RESPONSE: fakeStatusJson(),
        GITHUB_FAKE_CHECKS_RESPONSE: fakeChecksJson(),
        RUNS_DIR: runsDir,
      });
      const after = spawnSync('git', ['log', '--oneline'], { cwd: repoPath, encoding: 'utf-8', shell: false }).stdout;
      assert.strictEqual(before, after, 'No new commits should be created');
    } finally {
      cleanup();
    }
  });

  test('command does not push', () => {
    const { taskId, tasksFilePath, repoPath, runsDir, cleanup } = createTempEnv({ withState: true, withReports: true, withPrCreated: true });
    try {
      const before = spawnSync('git', ['log', '--oneline', '--all'], { cwd: repoPath, encoding: 'utf-8', shell: false }).stdout;
      runCli(['real-repo-pr-status', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_GITHUB_PR_STATUS: 'true',
        GITHUB_TOKEN: 'fake-token',
        GITHUB_REPOSITORY: 'test-owner/test-repo',
        GITHUB_FAKE_PR_RESPONSE: fakePrJson(),
        GITHUB_FAKE_STATUS_RESPONSE: fakeStatusJson(),
        GITHUB_FAKE_CHECKS_RESPONSE: fakeChecksJson(),
        RUNS_DIR: runsDir,
      });
      const after = spawnSync('git', ['log', '--oneline', '--all'], { cwd: repoPath, encoding: 'utf-8', shell: false }).stdout;
      assert.strictEqual(before, after, 'No new commits should be created');
    } finally {
      cleanup();
    }
  });

  test('command does not execute gh', () => {
    const { taskId, tasksFilePath, repoPath, runsDir, cleanup } = createTempEnv({ withState: true, withReports: true, withPrCreated: true });
    try {
      const before = spawnSync('git', ['log', '--oneline', '--all'], { cwd: repoPath, encoding: 'utf-8', shell: false }).stdout;
      runCli(['real-repo-pr-status', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_GITHUB_PR_STATUS: 'true',
        GITHUB_TOKEN: 'fake-token',
        GITHUB_REPOSITORY: 'test-owner/test-repo',
        GITHUB_FAKE_PR_RESPONSE: fakePrJson(),
        GITHUB_FAKE_STATUS_RESPONSE: fakeStatusJson(),
        GITHUB_FAKE_CHECKS_RESPONSE: fakeChecksJson(),
        RUNS_DIR: runsDir,
      });
      const after = spawnSync('git', ['log', '--oneline', '--all'], { cwd: repoPath, encoding: 'utf-8', shell: false }).stdout;
      assert.strictEqual(before, after, 'No git changes should occur');
    } finally {
      cleanup();
    }
  });

  test('command does not create PR', () => {
    const { taskId, tasksFilePath, runsDir, cleanup } = createTempEnv({ withState: true, withReports: true, withPrCreated: true });
    try {
      const result = runCli(['real-repo-pr-status', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_GITHUB_PR_STATUS: 'true',
        GITHUB_TOKEN: 'fake-token',
        GITHUB_REPOSITORY: 'test-owner/test-repo',
        GITHUB_FAKE_PR_RESPONSE: fakePrJson(),
        GITHUB_FAKE_STATUS_RESPONSE: fakeStatusJson(),
        GITHUB_FAKE_CHECKS_RESPONSE: fakeChecksJson(),
        RUNS_DIR: runsDir,
      });
      assert(result.stderr.includes('No PR was created'), `Expected no PR created message`);
    } finally {
      cleanup();
    }
  });

  test('command does not update PR', () => {
    const { taskId, tasksFilePath, runsDir, cleanup } = createTempEnv({ withState: true, withReports: true, withPrCreated: true });
    try {
      const result = runCli(['real-repo-pr-status', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_GITHUB_PR_STATUS: 'true',
        GITHUB_TOKEN: 'fake-token',
        GITHUB_REPOSITORY: 'test-owner/test-repo',
        GITHUB_FAKE_PR_RESPONSE: fakePrJson(),
        GITHUB_FAKE_STATUS_RESPONSE: fakeStatusJson(),
        GITHUB_FAKE_CHECKS_RESPONSE: fakeChecksJson(),
        RUNS_DIR: runsDir,
      });
      assert(result.stderr.includes('No PR was updated'), `Expected no PR updated message`);
    } finally {
      cleanup();
    }
  });

  test('command does not merge', () => {
    const { taskId, tasksFilePath, repoPath, runsDir, cleanup } = createTempEnv({ withState: true, withReports: true, withPrCreated: true });
    try {
      const before = spawnSync('git', ['log', '--oneline', 'main'], { cwd: repoPath, encoding: 'utf-8', shell: false }).stdout;
      runCli(['real-repo-pr-status', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_GITHUB_PR_STATUS: 'true',
        GITHUB_TOKEN: 'fake-token',
        GITHUB_REPOSITORY: 'test-owner/test-repo',
        GITHUB_FAKE_PR_RESPONSE: fakePrJson(),
        GITHUB_FAKE_STATUS_RESPONSE: fakeStatusJson(),
        GITHUB_FAKE_CHECKS_RESPONSE: fakeChecksJson(),
        RUNS_DIR: runsDir,
      });
      const after = spawnSync('git', ['log', '--oneline', 'main'], { cwd: repoPath, encoding: 'utf-8', shell: false }).stdout;
      assert.strictEqual(before, after, 'main must not change');
    } finally {
      cleanup();
    }
  });

  test('command does not checkout/switch', () => {
    const { taskId, tasksFilePath, repoPath, runsDir, cleanup } = createTempEnv({ withState: true, withReports: true, withPrCreated: true });
    try {
      const before = spawnSync('git', ['branch', '--show-current'], { cwd: repoPath, encoding: 'utf-8', shell: false }).stdout.trim();
      runCli(['real-repo-pr-status', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_GITHUB_PR_STATUS: 'true',
        GITHUB_TOKEN: 'fake-token',
        GITHUB_REPOSITORY: 'test-owner/test-repo',
        GITHUB_FAKE_PR_RESPONSE: fakePrJson(),
        GITHUB_FAKE_STATUS_RESPONSE: fakeStatusJson(),
        GITHUB_FAKE_CHECKS_RESPONSE: fakeChecksJson(),
        RUNS_DIR: runsDir,
      });
      const after = spawnSync('git', ['branch', '--show-current'], { cwd: repoPath, encoding: 'utf-8', shell: false }).stdout.trim();
      assert.strictEqual(before, after, 'Branch must not change');
    } finally {
      cleanup();
    }
  });

  test('command does not touch main', () => {
    const { taskId, tasksFilePath, repoPath, runsDir, cleanup } = createTempEnv({ withState: true, withReports: true, withPrCreated: true });
    try {
      const before = spawnSync('git', ['rev-parse', 'main'], { cwd: repoPath, encoding: 'utf-8', shell: false }).stdout.trim();
      runCli(['real-repo-pr-status', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_GITHUB_PR_STATUS: 'true',
        GITHUB_TOKEN: 'fake-token',
        GITHUB_REPOSITORY: 'test-owner/test-repo',
        GITHUB_FAKE_PR_RESPONSE: fakePrJson(),
        GITHUB_FAKE_STATUS_RESPONSE: fakeStatusJson(),
        GITHUB_FAKE_CHECKS_RESPONSE: fakeChecksJson(),
        RUNS_DIR: runsDir,
      });
      const after = spawnSync('git', ['rev-parse', 'main'], { cwd: repoPath, encoding: 'utf-8', shell: false }).stdout.trim();
      assert.strictEqual(before, after, 'main must not change');
    } finally {
      cleanup();
    }
  });

  test('command only writes pr-status-report.md and pr-status.json', () => {
    const { taskId, tasksFilePath, runsDir, cleanup } = createTempEnv({ withState: true, withReports: true, withPrCreated: true });
    try {
      runCli(['real-repo-pr-status', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_GITHUB_PR_STATUS: 'true',
        GITHUB_TOKEN: 'fake-token',
        GITHUB_REPOSITORY: 'test-owner/test-repo',
        GITHUB_FAKE_PR_RESPONSE: fakePrJson(),
        GITHUB_FAKE_STATUS_RESPONSE: fakeStatusJson(),
        GITHUB_FAKE_CHECKS_RESPONSE: fakeChecksJson(),
        RUNS_DIR: runsDir,
      });
      const files = readdirSync(join(runsDir, taskId));
      assert(files.includes('pr-status-report.md'), `Expected pr-status-report.md`);
      assert(files.includes('pr-status.json'), `Expected pr-status.json`);
      assert(files.includes('state.json'), `Expected state.json to remain`);
      assert(files.includes('approval-report.md'), `Expected approval-report.md to remain`);
      assert(files.includes('pr-readiness.md'), `Expected pr-readiness.md to remain`);
      assert(files.includes('pr-body.md'), `Expected pr-body.md to remain`);
      assert(files.includes('pr-created.json'), `Expected pr-created.json to remain`);
      assert.strictEqual(files.length, 7, `Expected exactly 7 files in run dir, got: ${files.join(', ')}`);
    } finally {
      cleanup();
    }
  });

  test('no stack trace in failure paths', () => {
    const { taskId, tasksFilePath, cleanup } = createTempEnv();
    try {
      const result = runCli(['real-repo-pr-status', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_GITHUB_PR_STATUS: 'true',
        GITHUB_TOKEN: 'fake-token',
        GITHUB_REPOSITORY: 'test-owner/test-repo',
      });
      assert.notStrictEqual(result.status, 0);
      assert(!result.stderr.includes('at '), `Stack trace leaked: ${result.stderr}`);
    } finally {
      cleanup();
    }
  });

  test('existing pr-create command unchanged', () => {
    const { taskId, tasksFilePath, runsDir, cleanup } = createTempEnv({ withState: true, withReports: true });
    try {
      mkdirSync(join(runsDir, taskId), { recursive: true });
      const commitSha = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: join(runsDir, '..', 'repo'), encoding: 'utf-8', shell: false }).stdout.trim();
      writeFileSync(join(runsDir, taskId, 'pr-created.json'), JSON.stringify({
        task_id: taskId,
        pr_number: 42,
        pr_url: 'https://github.com/test-owner/test-repo/pull/42',
        base: 'main',
        head: `ai/${taskId}`,
        commit_sha: commitSha,
        created_at: new Date().toISOString(),
        safety_note: 'PR created; merge not performed; human review required before merge',
      }), 'utf-8');
      const result = runCli(['real-repo-pr-create', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_GITHUB_PR_CREATE: 'true',
        GITHUB_TOKEN: 'fake-token',
        GITHUB_REPOSITORY: 'test-owner/test-repo',
        GITHUB_FAKE_PR_RESPONSE: JSON.stringify({ number: 42, html_url: 'https://github.com/test-owner/test-repo/pull/42' }),
        RUNS_DIR: runsDir,
      });
      assert.strictEqual(result.status, 0, `Expected pr-create success: ${result.stderr}`);
      assert(result.stderr.includes('PR created'), `Expected PR created`);
    } finally {
      cleanup();
    }
  });

  test('existing pr-readiness command unchanged', () => {
    const { taskId, tasksFilePath, runsDir, cleanup } = createTempEnv({ withState: true });
    try {
      mkdirSync(join(runsDir, taskId), { recursive: true });
      writeFileSync(join(runsDir, taskId, 'approval-report.md'), '# Approval report\n', 'utf-8');
      const result = runCli(['real-repo-pr-readiness', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_REPO_PR_READINESS: 'true',
        RUNS_DIR: runsDir,
      });
      assert.strictEqual(result.status, 0, `Expected pr-readiness success: ${result.stderr}`);
      assert(result.stderr.includes('PR readiness report written'), `Expected report written`);
    } finally {
      cleanup();
    }
  });

  test('existing approval-report command unchanged', () => {
    const { taskId, tasksFilePath, runsDir, cleanup } = createTempEnv({ withState: true });
    try {
      const result = runCli(['real-repo-approval-report', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_REPO_APPROVAL_REPORT: 'true',
        RUNS_DIR: runsDir,
      });
      assert.strictEqual(result.status, 0, `Expected approval report success: ${result.stderr}`);
      assert(result.stderr.includes('Approval report written'), `Expected approval report written`);
    } finally {
      cleanup();
    }
  });

  test('existing real-repo-run-ai behavior unchanged', () => {
    const { taskId, tasksFilePath, repoPath, runsDir, cleanup } = createTempEnv();
    try {
      const originPath = join(runsDir, '..', 'origin.git');
      spawnSync('git', ['init', '--bare', originPath], { encoding: 'utf-8', shell: false });
      spawnSync('git', ['remote', 'add', 'origin', originPath], { cwd: repoPath, encoding: 'utf-8', shell: false });
      const result = runCli(['real-repo-run-ai', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_PROVIDER: 'true',
        ALLOW_REAL_REPO_APPLY: 'true',
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_PUSH: 'true',
        KIMI_API_KEY: 'fake',
        KIMI_BASE_URL: 'http://localhost:9999',
        KIMI_FAKE_RESPONSE: JSON.stringify({ mode: 'file_update', files: [{ path: 'new.txt', content: 'hello' }] }),
        RUNS_DIR: runsDir,
      });
      assert.strictEqual(result.status, 0, `Expected success: ${result.stderr}`);
      assert(result.stderr.includes('Real provider run completed'), `Expected run completed`);
    } finally {
      cleanup();
    }
  });

  test('existing apply behavior unchanged', () => {
    const { taskId, tasksFilePath, runsDir, cleanup } = createTempEnv();
    try {
      const result = runCli(['real-repo-apply', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_REPO_APPLY: 'true',
        REAL_REPO_PROVIDER_RESPONSE: JSON.stringify({ mode: 'file_update', files: [] }),
        RUNS_DIR: runsDir,
      });
      assert.strictEqual(result.status, 0, `Expected apply success: ${result.stderr}`);
    } finally {
      cleanup();
    }
  });

  test('existing commit behavior unchanged', () => {
    const { taskId, tasksFilePath, repoPath, runsDir, cleanup } = createTempEnv();
    try {
      writeFileSync(join(repoPath, 'test.txt'), 'test', 'utf-8');
      spawnSync('git', ['add', 'test.txt'], { cwd: repoPath, encoding: 'utf-8', shell: false });
      const result = runCli(['real-repo-commit', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_APPLY: 'true',
        REAL_REPO_PROVIDER_RESPONSE: JSON.stringify({ mode: 'file_update', files: [{ path: 'test.txt', content: 'test' }] }),
        RUNS_DIR: runsDir,
      });
      assert.strictEqual(result.status, 0, `Expected commit success: ${result.stderr}`);
    } finally {
      cleanup();
    }
  });

  test('existing push behavior unchanged', () => {
    const { taskId, tasksFilePath, repoPath, runsDir, cleanup } = createTempEnv();
    try {
      const originPath = join(runsDir, '..', 'origin.git');
      spawnSync('git', ['init', '--bare', originPath], { encoding: 'utf-8', shell: false });
      spawnSync('git', ['remote', 'add', 'origin', originPath], { cwd: repoPath, encoding: 'utf-8', shell: false });
      writeFileSync(join(repoPath, 'test.txt'), 'test', 'utf-8');
      spawnSync('git', ['add', 'test.txt'], { cwd: repoPath, encoding: 'utf-8', shell: false });
      spawnSync('git', ['commit', '-m', 'test', '--no-gpg-sign'], { cwd: repoPath, encoding: 'utf-8', shell: false });
      const result = runCli(['real-repo-push', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_REPO_PUSH: 'true',
        RUNS_DIR: runsDir,
      });
      assert.strictEqual(result.status, 0, `Expected push success: ${result.stderr}`);
    } finally {
      cleanup();
    }
  });

  test('existing run behavior unchanged', () => {
    const { taskId, tasksFilePath, repoPath, runsDir, cleanup } = createTempEnv();
    try {
      const originPath = join(runsDir, '..', 'origin.git');
      spawnSync('git', ['init', '--bare', originPath], { encoding: 'utf-8', shell: false });
      spawnSync('git', ['remote', 'add', 'origin', originPath], { cwd: repoPath, encoding: 'utf-8', shell: false });
      const result = runCli(['real-repo-run', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_REPO_APPLY: 'true',
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_PUSH: 'true',
        REAL_REPO_PROVIDER_RESPONSE: JSON.stringify({ mode: 'file_update', files: [{ path: 'new.txt', content: 'hello' }] }),
        RUNS_DIR: runsDir,
      });
      assert.strictEqual(result.status, 0, `Expected run success: ${result.stderr}`);
    } finally {
      cleanup();
    }
  });
});

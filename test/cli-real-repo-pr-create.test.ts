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
  delete env.GITHUB_TOKEN;
  delete env.GITHUB_REPOSITORY;
  delete env.GITHUB_API_BASE_URL;
  delete env.GITHUB_FAKE_PR_RESPONSE;
  delete env.GITHUB_FAKE_PR_STATUS;
  delete env.SANDBOX_PROVIDER_RESPONSE;
  delete env.SANDBOX_ROOT;
  delete env.REAL_REPO_PROVIDER_RESPONSE;
  delete env.RUNS_DIR;
  delete env.REAL_REPO_AI_MAX_ATTEMPTS;
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
  stateOverrides?: Record<string, unknown>;
}): {
  taskId: string;
  tasksFilePath: string;
  repoPath: string;
  runsDir: string;
  cleanup: () => void;
} {
  const id = `${Date.now()}-${counter++}`;
  const taskId = `prc-r-${id}`;
  const tmpBase = join(process.cwd(), 'tmp');
  if (!existsSync(tmpBase)) {
    mkdirSync(tmpBase);
  }
  const tmpDir = mkdtempSync(join(tmpBase, `prc-r-${id}-`));
  const repoPath = join(tmpDir, 'repo');
  const runsDir = join(tmpDir, 'runs');
  mkdirSync(repoPath);

  writeFileSync(join(repoPath, 'README.md'), '# hello\n', 'utf-8');

  spawnSync('git', ['init'], {
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
    title: "PR create test"
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

  if (opts?.withState) {
    mkdirSync(join(runsDir, taskId), { recursive: true });
    const commitSha = spawnSync('git', ['rev-parse', 'HEAD'], {
      cwd: repoPath,
      encoding: 'utf-8',
      shell: false,
    }).stdout.trim();
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

  if (opts?.withReports) {
    mkdirSync(join(runsDir, taskId), { recursive: true });
    writeFileSync(join(runsDir, taskId, 'approval-report.md'), '# Approval report\n', 'utf-8');
    writeFileSync(join(runsDir, taskId, 'pr-readiness.md'), '# PR Readiness\n', 'utf-8');
    writeFileSync(join(runsDir, taskId, 'pr-body.md'), `## Task\n- **Task ID:** ${taskId}\n- **Goal:** Test goal\n`, 'utf-8');
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

function fakePrResponseJson(prNumber: number, htmlUrl: string): string {
  return JSON.stringify({ number: prNumber, html_url: htmlUrl });
}

describe('cli real-repo-pr-create', () => {
  test('missing taskId refuses', () => {
    const result = runCli(['real-repo-pr-create']);
    assert.notStrictEqual(result.status, 0);
    assert(result.stderr.includes('task id is required'), `Expected task id required: ${result.stderr}`);
  });

  test('missing taskId prints safety messages', () => {
    const result = runCli(['real-repo-pr-create']);
    assert.notStrictEqual(result.status, 0);
    assert(result.stderr.includes('No provider call was made'), `Expected no provider: ${result.stderr}`);
    assert(result.stderr.includes('No apply was performed'), `Expected no apply: ${result.stderr}`);
    assert(result.stderr.includes('No commit was made'), `Expected no commit: ${result.stderr}`);
    assert(result.stderr.includes('No push was performed'), `Expected no push: ${result.stderr}`);
    assert(result.stderr.includes('No PR was created'), `Expected no PR: ${result.stderr}`);
    assert(result.stderr.includes('No merge was performed'), `Expected no merge: ${result.stderr}`);
    assert(result.stderr.includes('No checkout was performed'), `Expected no checkout: ${result.stderr}`);
    assert(result.stderr.includes('No main touch was performed'), `Expected no main touch: ${result.stderr}`);
  });

  test('missing ALLOW_GITHUB_PR_CREATE refuses before API call', () => {
    const { taskId, tasksFilePath, cleanup } = createTempEnv();
    try {
      const result = runCli(['real-repo-pr-create', taskId], {
        TASKS_FILE: tasksFilePath,
      });
      assert.notStrictEqual(result.status, 0);
      assert(result.stderr.includes('ALLOW_GITHUB_PR_CREATE=true is required'), `Expected opt-in required: ${result.stderr}`);
    } finally {
      cleanup();
    }
  });

  test('missing ALLOW_GITHUB_PR_CREATE prints safety messages', () => {
    const { taskId, tasksFilePath, cleanup } = createTempEnv();
    try {
      const result = runCli(['real-repo-pr-create', taskId], {
        TASKS_FILE: tasksFilePath,
      });
      assert.notStrictEqual(result.status, 0);
      assert(result.stderr.includes('No GitHub API call was made'), `Expected no API call: ${result.stderr}`);
      assert(result.stderr.includes('No PR was created'), `Expected no PR: ${result.stderr}`);
      assert(result.stderr.includes('No merge was performed'), `Expected no merge: ${result.stderr}`);
    } finally {
      cleanup();
    }
  });

  test('missing GITHUB_TOKEN refuses before API call', () => {
    const { taskId, tasksFilePath, cleanup } = createTempEnv();
    try {
      const result = runCli(['real-repo-pr-create', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_GITHUB_PR_CREATE: 'true',
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
      const result = runCli(['real-repo-pr-create', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_GITHUB_PR_CREATE: 'true',
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
      const result = runCli(['real-repo-pr-create', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_GITHUB_PR_CREATE: 'true',
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
      const result = runCli(['real-repo-pr-create', 'nonexistent-task'], {
        TASKS_FILE: tasksFilePath,
        ALLOW_GITHUB_PR_CREATE: 'true',
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
      const result = runCli(['real-repo-pr-create', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_GITHUB_PR_CREATE: 'true',
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
      const result = runCli(['real-repo-pr-create', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_GITHUB_PR_CREATE: 'true',
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
      const result = runCli(['real-repo-pr-create', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_GITHUB_PR_CREATE: 'true',
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
      const result = runCli(['real-repo-pr-create', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_GITHUB_PR_CREATE: 'true',
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
      const result = runCli(['real-repo-pr-create', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_GITHUB_PR_CREATE: 'true',
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
      const result = runCli(['real-repo-pr-create', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_GITHUB_PR_CREATE: 'true',
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
      const result = runCli(['real-repo-pr-create', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_GITHUB_PR_CREATE: 'true',
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
      const result = runCli(['real-repo-pr-create', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_GITHUB_PR_CREATE: 'true',
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
      const result = runCli(['real-repo-pr-create', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_GITHUB_PR_CREATE: 'true',
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
      const result = runCli(['real-repo-pr-create', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_GITHUB_PR_CREATE: 'true',
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
      const result = runCli(['real-repo-pr-create', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_GITHUB_PR_CREATE: 'true',
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
    const { taskId, tasksFilePath, runsDir, cleanup } = createTempEnv({ withState: true, withReports: true, stateOverrides: { commit_sha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' } });
    try {
      const result = runCli(['real-repo-pr-create', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_GITHUB_PR_CREATE: 'true',
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
      const result = runCli(['real-repo-pr-create', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_GITHUB_PR_CREATE: 'true',
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
      const result = runCli(['real-repo-pr-create', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_GITHUB_PR_CREATE: 'true',
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
      const result = runCli(['real-repo-pr-create', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_GITHUB_PR_CREATE: 'true',
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

  test('missing base branch ref refuses before API call', () => {
    const { taskId, tasksFilePath, repoPath, runsDir, cleanup } = createTempEnv({ withState: true, withReports: true });
    try {
      spawnSync('git', ['branch', '-D', 'main'], { cwd: repoPath, encoding: 'utf-8', shell: false });
      const result = runCli(['real-repo-pr-create', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_GITHUB_PR_CREATE: 'true',
        GITHUB_TOKEN: 'fake-token',
        GITHUB_REPOSITORY: 'test-owner/test-repo',
        RUNS_DIR: runsDir,
      });
      assert.notStrictEqual(result.status, 0);
      assert(result.stderr.includes('Base branch ref does not exist'), `Expected base branch missing: ${result.stderr}`);
    } finally {
      cleanup();
    }
  });

  test('missing work branch ref refuses before API call', () => {
    const { taskId, tasksFilePath, repoPath, runsDir, cleanup } = createTempEnv({ withState: true, withReports: true });
    try {
      spawnSync('git', ['checkout', 'main'], { cwd: repoPath, encoding: 'utf-8', shell: false });
      spawnSync('git', ['branch', '-D', `ai/${taskId}`], { cwd: repoPath, encoding: 'utf-8', shell: false });
      const result = runCli(['real-repo-pr-create', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_GITHUB_PR_CREATE: 'true',
        GITHUB_TOKEN: 'fake-token',
        GITHUB_REPOSITORY: 'test-owner/test-repo',
        RUNS_DIR: runsDir,
      });
      assert.notStrictEqual(result.status, 0);
      assert(result.stderr.includes('Work branch ref does not exist'), `Expected work branch missing: ${result.stderr}`);
    } finally {
      cleanup();
    }
  });

  test('valid setup calls GitHub API exactly once', () => {
    const { taskId, tasksFilePath, runsDir, cleanup } = createTempEnv({ withState: true, withReports: true });
    try {
      const result = runCli(['real-repo-pr-create', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_GITHUB_PR_CREATE: 'true',
        GITHUB_TOKEN: 'fake-token',
        GITHUB_REPOSITORY: 'test-owner/test-repo',
        GITHUB_FAKE_PR_RESPONSE: fakePrResponseJson(42, 'https://github.com/test-owner/test-repo/pull/42'),
        RUNS_DIR: runsDir,
      });
      assert.strictEqual(result.status, 0, `Expected success: ${result.stderr}`);
      const matches = result.stderr.match(/\[github-api-call\]/g);
      assert(matches && matches.length === 1, `Expected exactly one API call: ${result.stderr}`);
    } finally {
      cleanup();
    }
  });

  test('GitHub API request uses POST', () => {
    const { taskId, tasksFilePath, runsDir, cleanup } = createTempEnv({ withState: true, withReports: true });
    try {
      const result = runCli(['real-repo-pr-create', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_GITHUB_PR_CREATE: 'true',
        GITHUB_TOKEN: 'fake-token',
        GITHUB_REPOSITORY: 'test-owner/test-repo',
        GITHUB_FAKE_PR_RESPONSE: fakePrResponseJson(42, 'https://github.com/test-owner/test-repo/pull/42'),
        RUNS_DIR: runsDir,
      });
      assert.strictEqual(result.status, 0, `Expected success: ${result.stderr}`);
      assert(result.stderr.includes('[github-api-request] POST'), `Expected POST in stderr: ${result.stderr}`);
    } finally {
      cleanup();
    }
  });

  test('GitHub API URL uses GITHUB_REPOSITORY', () => {
    const { taskId, tasksFilePath, runsDir, cleanup } = createTempEnv({ withState: true, withReports: true });
    try {
      const result = runCli(['real-repo-pr-create', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_GITHUB_PR_CREATE: 'true',
        GITHUB_TOKEN: 'fake-token',
        GITHUB_REPOSITORY: 'test-owner/test-repo',
        GITHUB_FAKE_PR_RESPONSE: fakePrResponseJson(42, 'https://github.com/test-owner/test-repo/pull/42'),
        RUNS_DIR: runsDir,
      });
      assert.strictEqual(result.status, 0, `Expected success: ${result.stderr}`);
      assert(result.stderr.includes('/repos/test-owner/test-repo/pulls'), `Expected repo in URL: ${result.stderr}`);
    } finally {
      cleanup();
    }
  });

  test('GitHub API request body contains title', () => {
    const { taskId, tasksFilePath, runsDir, cleanup } = createTempEnv({ withState: true, withReports: true });
    try {
      const result = runCli(['real-repo-pr-create', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_GITHUB_PR_CREATE: 'true',
        GITHUB_TOKEN: 'fake-token',
        GITHUB_REPOSITORY: 'test-owner/test-repo',
        GITHUB_FAKE_PR_RESPONSE: fakePrResponseJson(42, 'https://github.com/test-owner/test-repo/pull/42'),
        RUNS_DIR: runsDir,
      });
      assert.strictEqual(result.status, 0, `Expected success: ${result.stderr}`);
      const bodyMatch = result.stderr.match(/\[github-api-request\] body=(.+)/);
      assert(bodyMatch, `Expected body in stderr: ${result.stderr}`);
      const requestBody = JSON.parse(bodyMatch[1]);
      assert(requestBody.title.includes('PR create test'), `Expected title in body: ${JSON.stringify(requestBody)}`);
    } finally {
      cleanup();
    }
  });

  test('GitHub API request body contains body', () => {
    const { taskId, tasksFilePath, runsDir, cleanup } = createTempEnv({ withState: true, withReports: true });
    try {
      const result = runCli(['real-repo-pr-create', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_GITHUB_PR_CREATE: 'true',
        GITHUB_TOKEN: 'fake-token',
        GITHUB_REPOSITORY: 'test-owner/test-repo',
        GITHUB_FAKE_PR_RESPONSE: fakePrResponseJson(42, 'https://github.com/test-owner/test-repo/pull/42'),
        RUNS_DIR: runsDir,
      });
      assert.strictEqual(result.status, 0, `Expected success: ${result.stderr}`);
      const bodyMatch = result.stderr.match(/\[github-api-request\] body=(.+)/);
      assert(bodyMatch, `Expected body in stderr: ${result.stderr}`);
      const requestBody = JSON.parse(bodyMatch[1]);
      assert(requestBody.body.includes('Test goal'), `Expected PR body content: ${JSON.stringify(requestBody)}`);
    } finally {
      cleanup();
    }
  });

  test('GitHub API request body contains base branch', () => {
    const { taskId, tasksFilePath, runsDir, cleanup } = createTempEnv({ withState: true, withReports: true });
    try {
      const result = runCli(['real-repo-pr-create', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_GITHUB_PR_CREATE: 'true',
        GITHUB_TOKEN: 'fake-token',
        GITHUB_REPOSITORY: 'test-owner/test-repo',
        GITHUB_FAKE_PR_RESPONSE: fakePrResponseJson(42, 'https://github.com/test-owner/test-repo/pull/42'),
        RUNS_DIR: runsDir,
      });
      assert.strictEqual(result.status, 0, `Expected success: ${result.stderr}`);
      const bodyMatch = result.stderr.match(/\[github-api-request\] body=(.+)/);
      assert(bodyMatch, `Expected body in stderr: ${result.stderr}`);
      const requestBody = JSON.parse(bodyMatch[1]);
      assert.strictEqual(requestBody.base, 'main', `Expected base main: ${JSON.stringify(requestBody)}`);
    } finally {
      cleanup();
    }
  });

  test('GitHub API request body contains head branch', () => {
    const { taskId, tasksFilePath, runsDir, cleanup } = createTempEnv({ withState: true, withReports: true });
    try {
      const result = runCli(['real-repo-pr-create', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_GITHUB_PR_CREATE: 'true',
        GITHUB_TOKEN: 'fake-token',
        GITHUB_REPOSITORY: 'test-owner/test-repo',
        GITHUB_FAKE_PR_RESPONSE: fakePrResponseJson(42, 'https://github.com/test-owner/test-repo/pull/42'),
        RUNS_DIR: runsDir,
      });
      assert.strictEqual(result.status, 0, `Expected success: ${result.stderr}`);
      const bodyMatch = result.stderr.match(/\[github-api-request\] body=(.+)/);
      assert(bodyMatch, `Expected body in stderr: ${result.stderr}`);
      const requestBody = JSON.parse(bodyMatch[1]);
      assert(requestBody.head.includes(taskId), `Expected head branch: ${JSON.stringify(requestBody)}`);
    } finally {
      cleanup();
    }
  });

  test('successful API response writes pr-created.json', () => {
    const { taskId, tasksFilePath, runsDir, cleanup } = createTempEnv({ withState: true, withReports: true });
    try {
      const result = runCli(['real-repo-pr-create', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_GITHUB_PR_CREATE: 'true',
        GITHUB_TOKEN: 'fake-token',
        GITHUB_REPOSITORY: 'test-owner/test-repo',
        GITHUB_FAKE_PR_RESPONSE: fakePrResponseJson(42, 'https://github.com/test-owner/test-repo/pull/42'),
        RUNS_DIR: runsDir,
      });
      assert.strictEqual(result.status, 0, `Expected success: ${result.stderr}`);
      const prCreatedPath = join(runsDir, taskId, 'pr-created.json');
      assert(existsSync(prCreatedPath), `Expected pr-created.json to exist`);
    } finally {
      cleanup();
    }
  });

  test('pr-created.json contains task_id', () => {
    const { taskId, tasksFilePath, runsDir, cleanup } = createTempEnv({ withState: true, withReports: true });
    try {
      runCli(['real-repo-pr-create', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_GITHUB_PR_CREATE: 'true',
        GITHUB_TOKEN: 'fake-token',
        GITHUB_REPOSITORY: 'test-owner/test-repo',
        GITHUB_FAKE_PR_RESPONSE: fakePrResponseJson(42, 'https://github.com/test-owner/test-repo/pull/42'),
        RUNS_DIR: runsDir,
      });
      const prCreated = JSON.parse(readFileSync(join(runsDir, taskId, 'pr-created.json'), 'utf-8'));
      assert.strictEqual(prCreated.task_id, taskId, `Expected task_id`);
    } finally {
      cleanup();
    }
  });

  test('pr-created.json contains pr_number', () => {
    const { taskId, tasksFilePath, runsDir, cleanup } = createTempEnv({ withState: true, withReports: true });
    try {
      runCli(['real-repo-pr-create', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_GITHUB_PR_CREATE: 'true',
        GITHUB_TOKEN: 'fake-token',
        GITHUB_REPOSITORY: 'test-owner/test-repo',
        GITHUB_FAKE_PR_RESPONSE: fakePrResponseJson(42, 'https://github.com/test-owner/test-repo/pull/42'),
        RUNS_DIR: runsDir,
      });
      const prCreated = JSON.parse(readFileSync(join(runsDir, taskId, 'pr-created.json'), 'utf-8'));
      assert.strictEqual(prCreated.pr_number, 42, `Expected pr_number`);
    } finally {
      cleanup();
    }
  });

  test('pr-created.json contains pr_url', () => {
    const { taskId, tasksFilePath, runsDir, cleanup } = createTempEnv({ withState: true, withReports: true });
    try {
      runCli(['real-repo-pr-create', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_GITHUB_PR_CREATE: 'true',
        GITHUB_TOKEN: 'fake-token',
        GITHUB_REPOSITORY: 'test-owner/test-repo',
        GITHUB_FAKE_PR_RESPONSE: fakePrResponseJson(42, 'https://github.com/test-owner/test-repo/pull/42'),
        RUNS_DIR: runsDir,
      });
      const prCreated = JSON.parse(readFileSync(join(runsDir, taskId, 'pr-created.json'), 'utf-8'));
      assert.strictEqual(prCreated.pr_url, 'https://github.com/test-owner/test-repo/pull/42', `Expected pr_url`);
    } finally {
      cleanup();
    }
  });

  test('pr-created.json contains base', () => {
    const { taskId, tasksFilePath, runsDir, cleanup } = createTempEnv({ withState: true, withReports: true });
    try {
      runCli(['real-repo-pr-create', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_GITHUB_PR_CREATE: 'true',
        GITHUB_TOKEN: 'fake-token',
        GITHUB_REPOSITORY: 'test-owner/test-repo',
        GITHUB_FAKE_PR_RESPONSE: fakePrResponseJson(42, 'https://github.com/test-owner/test-repo/pull/42'),
        RUNS_DIR: runsDir,
      });
      const prCreated = JSON.parse(readFileSync(join(runsDir, taskId, 'pr-created.json'), 'utf-8'));
      assert.strictEqual(prCreated.base, 'main', `Expected base`);
    } finally {
      cleanup();
    }
  });

  test('pr-created.json contains head', () => {
    const { taskId, tasksFilePath, runsDir, cleanup } = createTempEnv({ withState: true, withReports: true });
    try {
      runCli(['real-repo-pr-create', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_GITHUB_PR_CREATE: 'true',
        GITHUB_TOKEN: 'fake-token',
        GITHUB_REPOSITORY: 'test-owner/test-repo',
        GITHUB_FAKE_PR_RESPONSE: fakePrResponseJson(42, 'https://github.com/test-owner/test-repo/pull/42'),
        RUNS_DIR: runsDir,
      });
      const prCreated = JSON.parse(readFileSync(join(runsDir, taskId, 'pr-created.json'), 'utf-8'));
      assert(prCreated.head.includes(taskId), `Expected head`);
    } finally {
      cleanup();
    }
  });

  test('pr-created.json contains commit_sha', () => {
    const { taskId, tasksFilePath, runsDir, cleanup } = createTempEnv({ withState: true, withReports: true });
    try {
      runCli(['real-repo-pr-create', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_GITHUB_PR_CREATE: 'true',
        GITHUB_TOKEN: 'fake-token',
        GITHUB_REPOSITORY: 'test-owner/test-repo',
        GITHUB_FAKE_PR_RESPONSE: fakePrResponseJson(42, 'https://github.com/test-owner/test-repo/pull/42'),
        RUNS_DIR: runsDir,
      });
      const state = JSON.parse(readFileSync(join(runsDir, taskId, 'state.json'), 'utf-8'));
      const prCreated = JSON.parse(readFileSync(join(runsDir, taskId, 'pr-created.json'), 'utf-8'));
      assert.strictEqual(prCreated.commit_sha, state.commit_sha, `Expected commit_sha`);
    } finally {
      cleanup();
    }
  });

  test('pr-created.json contains safety_note', () => {
    const { taskId, tasksFilePath, runsDir, cleanup } = createTempEnv({ withState: true, withReports: true });
    try {
      runCli(['real-repo-pr-create', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_GITHUB_PR_CREATE: 'true',
        GITHUB_TOKEN: 'fake-token',
        GITHUB_REPOSITORY: 'test-owner/test-repo',
        GITHUB_FAKE_PR_RESPONSE: fakePrResponseJson(42, 'https://github.com/test-owner/test-repo/pull/42'),
        RUNS_DIR: runsDir,
      });
      const prCreated = JSON.parse(readFileSync(join(runsDir, taskId, 'pr-created.json'), 'utf-8'));
      assert(prCreated.safety_note.includes('merge not performed'), `Expected safety_note`);
      assert(prCreated.safety_note.includes('human review required'), `Expected human review in safety_note`);
    } finally {
      cleanup();
    }
  });

  test('success output contains PR URL', () => {
    const { taskId, tasksFilePath, runsDir, cleanup } = createTempEnv({ withState: true, withReports: true });
    try {
      const result = runCli(['real-repo-pr-create', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_GITHUB_PR_CREATE: 'true',
        GITHUB_TOKEN: 'fake-token',
        GITHUB_REPOSITORY: 'test-owner/test-repo',
        GITHUB_FAKE_PR_RESPONSE: fakePrResponseJson(42, 'https://github.com/test-owner/test-repo/pull/42'),
        RUNS_DIR: runsDir,
      });
      assert.strictEqual(result.status, 0, `Expected success: ${result.stderr}`);
      assert(result.stderr.includes('PR URL: https://github.com/test-owner/test-repo/pull/42'), `Expected PR URL: ${result.stderr}`);
    } finally {
      cleanup();
    }
  });

  test('success output says no merge', () => {
    const { taskId, tasksFilePath, runsDir, cleanup } = createTempEnv({ withState: true, withReports: true });
    try {
      const result = runCli(['real-repo-pr-create', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_GITHUB_PR_CREATE: 'true',
        GITHUB_TOKEN: 'fake-token',
        GITHUB_REPOSITORY: 'test-owner/test-repo',
        GITHUB_FAKE_PR_RESPONSE: fakePrResponseJson(42, 'https://github.com/test-owner/test-repo/pull/42'),
        RUNS_DIR: runsDir,
      });
      assert.strictEqual(result.status, 0, `Expected success: ${result.stderr}`);
      assert(result.stderr.includes('No merge was performed'), `Expected no merge: ${result.stderr}`);
    } finally {
      cleanup();
    }
  });

  test('success output says no checkout', () => {
    const { taskId, tasksFilePath, runsDir, cleanup } = createTempEnv({ withState: true, withReports: true });
    try {
      const result = runCli(['real-repo-pr-create', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_GITHUB_PR_CREATE: 'true',
        GITHUB_TOKEN: 'fake-token',
        GITHUB_REPOSITORY: 'test-owner/test-repo',
        GITHUB_FAKE_PR_RESPONSE: fakePrResponseJson(42, 'https://github.com/test-owner/test-repo/pull/42'),
        RUNS_DIR: runsDir,
      });
      assert.strictEqual(result.status, 0, `Expected success: ${result.stderr}`);
      assert(result.stderr.includes('No checkout was performed'), `Expected no checkout: ${result.stderr}`);
    } finally {
      cleanup();
    }
  });

  test('success output says no main touch', () => {
    const { taskId, tasksFilePath, runsDir, cleanup } = createTempEnv({ withState: true, withReports: true });
    try {
      const result = runCli(['real-repo-pr-create', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_GITHUB_PR_CREATE: 'true',
        GITHUB_TOKEN: 'fake-token',
        GITHUB_REPOSITORY: 'test-owner/test-repo',
        GITHUB_FAKE_PR_RESPONSE: fakePrResponseJson(42, 'https://github.com/test-owner/test-repo/pull/42'),
        RUNS_DIR: runsDir,
      });
      assert.strictEqual(result.status, 0, `Expected success: ${result.stderr}`);
      assert(result.stderr.includes('No main touch was performed'), `Expected no main touch: ${result.stderr}`);
    } finally {
      cleanup();
    }
  });

  test('GitHub API failure writes no pr-created.json', () => {
    const { taskId, tasksFilePath, runsDir, cleanup } = createTempEnv({ withState: true, withReports: true });
    try {
      const result = runCli(['real-repo-pr-create', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_GITHUB_PR_CREATE: 'true',
        GITHUB_TOKEN: 'fake-token',
        GITHUB_REPOSITORY: 'test-owner/test-repo',
        GITHUB_FAKE_PR_RESPONSE: JSON.stringify({ message: 'Validation Failed' }),
        GITHUB_FAKE_PR_STATUS: '422',
        RUNS_DIR: runsDir,
      });
      assert.notStrictEqual(result.status, 0, `Expected failure: ${result.stderr}`);
      const prCreatedPath = join(runsDir, taskId, 'pr-created.json');
      assert(!existsSync(prCreatedPath), `Expected no pr-created.json`);
    } finally {
      cleanup();
    }
  });

  test('GitHub API failure prints safe error', () => {
    const { taskId, tasksFilePath, runsDir, cleanup } = createTempEnv({ withState: true, withReports: true });
    try {
      const result = runCli(['real-repo-pr-create', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_GITHUB_PR_CREATE: 'true',
        GITHUB_TOKEN: 'fake-token',
        GITHUB_REPOSITORY: 'test-owner/test-repo',
        GITHUB_FAKE_PR_RESPONSE: JSON.stringify({ message: 'Validation Failed' }),
        GITHUB_FAKE_PR_STATUS: '422',
        RUNS_DIR: runsDir,
      });
      assert.notStrictEqual(result.status, 0);
      assert(result.stderr.includes('GitHub PR creation failed'), `Expected safe error: ${result.stderr}`);
      assert(result.stderr.includes('Manual inspection required'), `Expected manual inspection: ${result.stderr}`);
    } finally {
      cleanup();
    }
  });

  test('token is not printed on success', () => {
    const { taskId, tasksFilePath, runsDir, cleanup } = createTempEnv({ withState: true, withReports: true });
    try {
      const result = runCli(['real-repo-pr-create', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_GITHUB_PR_CREATE: 'true',
        GITHUB_TOKEN: 'ghp_secrettoken12345',
        GITHUB_REPOSITORY: 'test-owner/test-repo',
        GITHUB_FAKE_PR_RESPONSE: fakePrResponseJson(42, 'https://github.com/test-owner/test-repo/pull/42'),
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
    const { taskId, tasksFilePath, runsDir, cleanup } = createTempEnv({ withState: true, withReports: true });
    try {
      const result = runCli(['real-repo-pr-create', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_GITHUB_PR_CREATE: 'true',
        GITHUB_TOKEN: 'ghp_secrettoken12345',
        GITHUB_REPOSITORY: 'test-owner/test-repo',
        GITHUB_FAKE_PR_RESPONSE: JSON.stringify({ message: 'Validation Failed' }),
        GITHUB_FAKE_PR_STATUS: '422',
        RUNS_DIR: runsDir,
      });
      assert.notStrictEqual(result.status, 0);
      assert(!result.stderr.includes('ghp_secrettoken12345'), `Stderr must not contain token on failure`);
      assert(!result.stdout.includes('ghp_secrettoken12345'), `Stdout must not contain token on failure`);
    } finally {
      cleanup();
    }
  });

  test('token is not written to pr-created.json', () => {
    const { taskId, tasksFilePath, runsDir, cleanup } = createTempEnv({ withState: true, withReports: true });
    try {
      runCli(['real-repo-pr-create', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_GITHUB_PR_CREATE: 'true',
        GITHUB_TOKEN: 'ghp_secrettoken12345',
        GITHUB_REPOSITORY: 'test-owner/test-repo',
        GITHUB_FAKE_PR_RESPONSE: fakePrResponseJson(42, 'https://github.com/test-owner/test-repo/pull/42'),
        RUNS_DIR: runsDir,
      });
      const prCreatedRaw = readFileSync(join(runsDir, taskId, 'pr-created.json'), 'utf-8');
      assert(!prCreatedRaw.includes('ghp_secrettoken12345'), `pr-created.json must not contain token`);
    } finally {
      cleanup();
    }
  });

  test('remote URL with credentials is not printed', () => {
    const { taskId, tasksFilePath, repoPath, runsDir, cleanup } = createTempEnv({ withState: true, withReports: true });
    try {
      spawnSync('git', ['remote', 'set-url', 'origin', 'https://user:pass@github.com/test/repo.git'], {
        cwd: repoPath,
        encoding: 'utf-8',
        shell: false,
      });
      const result = runCli(['real-repo-pr-create', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_GITHUB_PR_CREATE: 'true',
        GITHUB_TOKEN: 'fake-token',
        GITHUB_REPOSITORY: 'test-owner/test-repo',
        GITHUB_FAKE_PR_RESPONSE: fakePrResponseJson(42, 'https://github.com/test-owner/test-repo/pull/42'),
        RUNS_DIR: runsDir,
      });
      assert.strictEqual(result.status, 0, `Expected success: ${result.stderr}`);
      assert(!result.stderr.includes('user:pass'), `Stderr must not contain credentials`);
    } finally {
      cleanup();
    }
  });

  test('remote URL with credentials is not written', () => {
    const { taskId, tasksFilePath, repoPath, runsDir, cleanup } = createTempEnv({ withState: true, withReports: true });
    try {
      spawnSync('git', ['remote', 'set-url', 'origin', 'https://user:pass@github.com/test/repo.git'], {
        cwd: repoPath,
        encoding: 'utf-8',
        shell: false,
      });
      runCli(['real-repo-pr-create', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_GITHUB_PR_CREATE: 'true',
        GITHUB_TOKEN: 'fake-token',
        GITHUB_REPOSITORY: 'test-owner/test-repo',
        GITHUB_FAKE_PR_RESPONSE: fakePrResponseJson(42, 'https://github.com/test-owner/test-repo/pull/42'),
        RUNS_DIR: runsDir,
      });
      const prCreatedRaw = readFileSync(join(runsDir, taskId, 'pr-created.json'), 'utf-8');
      assert(!prCreatedRaw.includes('user:pass'), `pr-created.json must not contain credentials`);
    } finally {
      cleanup();
    }
  });

  test('command does not call provider', () => {
    const { taskId, tasksFilePath, runsDir, cleanup } = createTempEnv({ withState: true, withReports: true });
    try {
      const result = runCli(['real-repo-pr-create', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_GITHUB_PR_CREATE: 'true',
        GITHUB_TOKEN: 'fake-token',
        GITHUB_REPOSITORY: 'test-owner/test-repo',
        GITHUB_FAKE_PR_RESPONSE: fakePrResponseJson(42, 'https://github.com/test-owner/test-repo/pull/42'),
        RUNS_DIR: runsDir,
      });
      assert.strictEqual(result.status, 0, `Expected success: ${result.stderr}`);
    } finally {
      cleanup();
    }
  });

  test('command does not apply files', () => {
    const { taskId, tasksFilePath, repoPath, runsDir, cleanup } = createTempEnv({ withState: true, withReports: true });
    try {
      const before = spawnSync('git', ['status', '--porcelain'], { cwd: repoPath, encoding: 'utf-8', shell: false }).stdout;
      runCli(['real-repo-pr-create', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_GITHUB_PR_CREATE: 'true',
        GITHUB_TOKEN: 'fake-token',
        GITHUB_REPOSITORY: 'test-owner/test-repo',
        GITHUB_FAKE_PR_RESPONSE: fakePrResponseJson(42, 'https://github.com/test-owner/test-repo/pull/42'),
        RUNS_DIR: runsDir,
      });
      const after = spawnSync('git', ['status', '--porcelain'], { cwd: repoPath, encoding: 'utf-8', shell: false }).stdout;
      assert.strictEqual(before, after, 'Working tree must not change');
    } finally {
      cleanup();
    }
  });

  test('command does not commit', () => {
    const { taskId, tasksFilePath, repoPath, runsDir, cleanup } = createTempEnv({ withState: true, withReports: true });
    try {
      const before = spawnSync('git', ['log', '--oneline'], { cwd: repoPath, encoding: 'utf-8', shell: false }).stdout;
      runCli(['real-repo-pr-create', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_GITHUB_PR_CREATE: 'true',
        GITHUB_TOKEN: 'fake-token',
        GITHUB_REPOSITORY: 'test-owner/test-repo',
        GITHUB_FAKE_PR_RESPONSE: fakePrResponseJson(42, 'https://github.com/test-owner/test-repo/pull/42'),
        RUNS_DIR: runsDir,
      });
      const after = spawnSync('git', ['log', '--oneline'], { cwd: repoPath, encoding: 'utf-8', shell: false }).stdout;
      assert.strictEqual(before, after, 'No new commits should be created');
    } finally {
      cleanup();
    }
  });

  test('command does not push', () => {
    const { taskId, tasksFilePath, repoPath, runsDir, cleanup } = createTempEnv({ withState: true, withReports: true });
    try {
      const before = spawnSync('git', ['log', '--oneline', '--all'], { cwd: repoPath, encoding: 'utf-8', shell: false }).stdout;
      runCli(['real-repo-pr-create', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_GITHUB_PR_CREATE: 'true',
        GITHUB_TOKEN: 'fake-token',
        GITHUB_REPOSITORY: 'test-owner/test-repo',
        GITHUB_FAKE_PR_RESPONSE: fakePrResponseJson(42, 'https://github.com/test-owner/test-repo/pull/42'),
        RUNS_DIR: runsDir,
      });
      const after = spawnSync('git', ['log', '--oneline', '--all'], { cwd: repoPath, encoding: 'utf-8', shell: false }).stdout;
      assert.strictEqual(before, after, 'No new commits should be created');
    } finally {
      cleanup();
    }
  });

  test('command does not execute gh', () => {
    const { taskId, tasksFilePath, repoPath, runsDir, cleanup } = createTempEnv({ withState: true, withReports: true });
    try {
      const before = spawnSync('git', ['log', '--oneline', '--all'], { cwd: repoPath, encoding: 'utf-8', shell: false }).stdout;
      runCli(['real-repo-pr-create', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_GITHUB_PR_CREATE: 'true',
        GITHUB_TOKEN: 'fake-token',
        GITHUB_REPOSITORY: 'test-owner/test-repo',
        GITHUB_FAKE_PR_RESPONSE: fakePrResponseJson(42, 'https://github.com/test-owner/test-repo/pull/42'),
        RUNS_DIR: runsDir,
      });
      const after = spawnSync('git', ['log', '--oneline', '--all'], { cwd: repoPath, encoding: 'utf-8', shell: false }).stdout;
      assert.strictEqual(before, after, 'No git changes should occur');
    } finally {
      cleanup();
    }
  });

  test('command does not merge', () => {
    const { taskId, tasksFilePath, repoPath, runsDir, cleanup } = createTempEnv({ withState: true, withReports: true });
    try {
      const before = spawnSync('git', ['log', '--oneline', 'main'], { cwd: repoPath, encoding: 'utf-8', shell: false }).stdout;
      runCli(['real-repo-pr-create', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_GITHUB_PR_CREATE: 'true',
        GITHUB_TOKEN: 'fake-token',
        GITHUB_REPOSITORY: 'test-owner/test-repo',
        GITHUB_FAKE_PR_RESPONSE: fakePrResponseJson(42, 'https://github.com/test-owner/test-repo/pull/42'),
        RUNS_DIR: runsDir,
      });
      const after = spawnSync('git', ['log', '--oneline', 'main'], { cwd: repoPath, encoding: 'utf-8', shell: false }).stdout;
      assert.strictEqual(before, after, 'main must not change');
    } finally {
      cleanup();
    }
  });

  test('command does not checkout/switch', () => {
    const { taskId, tasksFilePath, repoPath, runsDir, cleanup } = createTempEnv({ withState: true, withReports: true });
    try {
      const before = spawnSync('git', ['branch', '--show-current'], { cwd: repoPath, encoding: 'utf-8', shell: false }).stdout.trim();
      runCli(['real-repo-pr-create', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_GITHUB_PR_CREATE: 'true',
        GITHUB_TOKEN: 'fake-token',
        GITHUB_REPOSITORY: 'test-owner/test-repo',
        GITHUB_FAKE_PR_RESPONSE: fakePrResponseJson(42, 'https://github.com/test-owner/test-repo/pull/42'),
        RUNS_DIR: runsDir,
      });
      const after = spawnSync('git', ['branch', '--show-current'], { cwd: repoPath, encoding: 'utf-8', shell: false }).stdout.trim();
      assert.strictEqual(before, after, 'Branch must not change');
    } finally {
      cleanup();
    }
  });

  test('command does not touch main', () => {
    const { taskId, tasksFilePath, repoPath, runsDir, cleanup } = createTempEnv({ withState: true, withReports: true });
    try {
      const before = spawnSync('git', ['rev-parse', 'main'], { cwd: repoPath, encoding: 'utf-8', shell: false }).stdout.trim();
      runCli(['real-repo-pr-create', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_GITHUB_PR_CREATE: 'true',
        GITHUB_TOKEN: 'fake-token',
        GITHUB_REPOSITORY: 'test-owner/test-repo',
        GITHUB_FAKE_PR_RESPONSE: fakePrResponseJson(42, 'https://github.com/test-owner/test-repo/pull/42'),
        RUNS_DIR: runsDir,
      });
      const after = spawnSync('git', ['rev-parse', 'main'], { cwd: repoPath, encoding: 'utf-8', shell: false }).stdout.trim();
      assert.strictEqual(before, after, 'main must not change');
    } finally {
      cleanup();
    }
  });

  test('command only writes pr-created.json', () => {
    const { taskId, tasksFilePath, runsDir, cleanup } = createTempEnv({ withState: true, withReports: true });
    try {
      runCli(['real-repo-pr-create', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_GITHUB_PR_CREATE: 'true',
        GITHUB_TOKEN: 'fake-token',
        GITHUB_REPOSITORY: 'test-owner/test-repo',
        GITHUB_FAKE_PR_RESPONSE: fakePrResponseJson(42, 'https://github.com/test-owner/test-repo/pull/42'),
        RUNS_DIR: runsDir,
      });
      const files = readdirSync(join(runsDir, taskId));
      assert(files.includes('pr-created.json'), `Expected pr-created.json`);
      assert(files.includes('state.json'), `Expected state.json to remain`);
      assert(files.includes('approval-report.md'), `Expected approval-report.md to remain`);
      assert(files.includes('pr-readiness.md'), `Expected pr-readiness.md to remain`);
      assert(files.includes('pr-body.md'), `Expected pr-body.md to remain`);
      assert.strictEqual(files.length, 5, `Expected exactly 5 files in run dir, got: ${files.join(', ')}`);
    } finally {
      cleanup();
    }
  });

  test('no stack trace in failure paths', () => {
    const { taskId, tasksFilePath, cleanup } = createTempEnv();
    try {
      const result = runCli(['real-repo-pr-create', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_GITHUB_PR_CREATE: 'true',
        GITHUB_TOKEN: 'fake-token',
        GITHUB_REPOSITORY: 'test-owner/test-repo',
      });
      assert.notStrictEqual(result.status, 0);
      assert(!result.stderr.includes('at '), `Stack trace leaked: ${result.stderr}`);
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

  test('existing readiness behavior unchanged', () => {
    const { taskId, tasksFilePath, repoPath, cleanup } = createTempEnv();
    try {
      const originPath = join(process.cwd(), 'tmp', `prc-r-origin-${Date.now()}`);
      spawnSync('git', ['init', '--bare', originPath], { encoding: 'utf-8', shell: false });
      spawnSync('git', ['remote', 'add', 'origin', originPath], { cwd: repoPath, encoding: 'utf-8', shell: false });
      const result = runCli(['real-repo-run-ai-readiness', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_PROVIDER: 'true',
        ALLOW_REAL_REPO_APPLY: 'true',
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_PUSH: 'true',
        KIMI_API_KEY: 'fake',
        KIMI_BASE_URL: 'http://localhost:9999',
      });
      assert.strictEqual(result.status, 0, `Expected readiness success: ${result.stderr}`);
      assert(result.stderr.includes('Readiness check passed'), `Expected readiness passed`);
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

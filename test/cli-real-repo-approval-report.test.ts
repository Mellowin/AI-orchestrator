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
  stateOverrides?: Record<string, unknown>;
  baseBranch?: string;
}): {
  taskId: string;
  tasksFilePath: string;
  repoPath: string;
  runsDir: string;
  cleanup: () => void;
} {
  const id = `${Date.now()}-${counter++}`;
  const taskId = `apr-r-${id}`;
  const tmpBase = join(process.cwd(), 'tmp');
  if (!existsSync(tmpBase)) {
    mkdirSync(tmpBase);
  }
  const tmpDir = mkdtempSync(join(tmpBase, `apr-r-${id}-`));
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

  const baseBranch = opts?.baseBranch ?? 'main';

  const tasksFilePath = join(tmpDir, 'tasks.yaml');
  writeFileSync(
    tasksFilePath,
    `tasks:
  - id: ${taskId}
    title: "Approval report test"
    repo_path: "${repoPath.replace(/\\/g, '/')}"
    base_branch: "${baseBranch}"
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

describe('cli real-repo-approval-report', () => {
  test('missing taskId refuses', () => {
    const result = runCli(['real-repo-approval-report']);
    assert.notStrictEqual(result.status, 0);
    assert(result.stderr.includes('task id is required'), `Expected task id required: ${result.stderr}`);
  });

  test('missing taskId prints safety messages', () => {
    const result = runCli(['real-repo-approval-report']);
    assert.notStrictEqual(result.status, 0);
    assert(result.stderr.includes('No PR was created'), `Expected no PR: ${result.stderr}`);
    assert(result.stderr.includes('No merge was performed'), `Expected no merge: ${result.stderr}`);
    assert(result.stderr.includes('No checkout was performed'), `Expected no checkout: ${result.stderr}`);
    assert(result.stderr.includes('No main touch was performed'), `Expected no main touch: ${result.stderr}`);
  });

  test('missing opt-in refuses', () => {
    const { taskId, tasksFilePath, cleanup } = createTempEnv();
    try {
      const result = runCli(['real-repo-approval-report', taskId], {
        TASKS_FILE: tasksFilePath,
      });
      assert.notStrictEqual(result.status, 0);
      assert(result.stderr.includes('ALLOW_REAL_REPO_APPROVAL_REPORT=true is required'), `Expected opt-in required: ${result.stderr}`);
    } finally {
      cleanup();
    }
  });

  test('missing opt-in prints safety messages', () => {
    const { taskId, tasksFilePath, cleanup } = createTempEnv();
    try {
      const result = runCli(['real-repo-approval-report', taskId], {
        TASKS_FILE: tasksFilePath,
      });
      assert.notStrictEqual(result.status, 0);
      assert(result.stderr.includes('No PR was created'), `Expected no PR: ${result.stderr}`);
      assert(result.stderr.includes('No merge was performed'), `Expected no merge: ${result.stderr}`);
    } finally {
      cleanup();
    }
  });

  test('missing task refuses', () => {
    const { tasksFilePath, cleanup } = createTempEnv();
    try {
      const result = runCli(['real-repo-approval-report', 'nonexistent-task'], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_REPO_APPROVAL_REPORT: 'true',
      });
      assert.notStrictEqual(result.status, 0);
      assert(result.stderr.includes('not found') || result.stderr.includes('Error:'), `Expected error: ${result.stderr}`);
    } finally {
      cleanup();
    }
  });

  test('missing repo_path refuses', () => {
    const { taskId, tasksFilePath, cleanup } = createTempEnv();
    try {
      const content = readFileSync(tasksFilePath, 'utf-8');
      writeFileSync(tasksFilePath, content.replace(/repo_path: "[^"]+"/, 'repo_path: "/nonexistent/path"'), 'utf-8');
      const result = runCli(['real-repo-approval-report', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_REPO_APPROVAL_REPORT: 'true',
      });
      assert.notStrictEqual(result.status, 0);
      assert(result.stderr.includes('repo_path does not exist'), `Expected repo_path error: ${result.stderr}`);
    } finally {
      cleanup();
    }
  });

  test('missing work_branch refuses', () => {
    const { taskId, tasksFilePath, cleanup } = createTempEnv();
    try {
      const content = readFileSync(tasksFilePath, 'utf-8');
      writeFileSync(tasksFilePath, content.replace(`work_branch: "ai/${taskId}"`, 'work_branch: ""'), 'utf-8');
      const result = runCli(['real-repo-approval-report', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_REPO_APPROVAL_REPORT: 'true',
      });
      assert.notStrictEqual(result.status, 0);
      assert(result.stderr.includes('work_branch is missing'), `Expected work_branch missing: ${result.stderr}`);
    } finally {
      cleanup();
    }
  });

  test('work_branch main refuses', () => {
    const { taskId, tasksFilePath, cleanup } = createTempEnv();
    try {
      const content = readFileSync(tasksFilePath, 'utf-8');
      writeFileSync(tasksFilePath, content.replace(`work_branch: "ai/${taskId}"`, 'work_branch: "main"'), 'utf-8');
      const result = runCli(['real-repo-approval-report', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_REPO_APPROVAL_REPORT: 'true',
      });
      assert.notStrictEqual(result.status, 0);
      assert(result.stderr.includes('work_branch is main'), `Expected work_branch main: ${result.stderr}`);
    } finally {
      cleanup();
    }
  });

  test('missing state refuses', () => {
    const { taskId, tasksFilePath, cleanup } = createTempEnv();
    try {
      const result = runCli(['real-repo-approval-report', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_REPO_APPROVAL_REPORT: 'true',
      });
      assert.notStrictEqual(result.status, 0);
      assert(result.stderr.includes('State file does not exist'), `Expected missing state: ${result.stderr}`);
    } finally {
      cleanup();
    }
  });

  test('state status not pushed refuses', () => {
    const { taskId, tasksFilePath, runsDir, cleanup } = createTempEnv({ withState: true, stateOverrides: { status: 'reviewing' } });
    try {
      const result = runCli(['real-repo-approval-report', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_REPO_APPROVAL_REPORT: 'true',
        RUNS_DIR: runsDir,
      });
      assert.notStrictEqual(result.status, 0);
      assert(result.stderr.includes('expected pushed'), `Expected pushed status: ${result.stderr}`);
    } finally {
      cleanup();
    }
  });

  test('state task_id mismatch refuses', () => {
    const { taskId, tasksFilePath, runsDir, cleanup } = createTempEnv({ withState: true, stateOverrides: { task_id: 'other-task' } });
    try {
      const result = runCli(['real-repo-approval-report', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_REPO_APPROVAL_REPORT: 'true',
        RUNS_DIR: runsDir,
      });
      assert.notStrictEqual(result.status, 0);
      assert(result.stderr.includes('task_id mismatch'), `Expected task_id mismatch: ${result.stderr}`);
    } finally {
      cleanup();
    }
  });

  test('state branch mismatch refuses', () => {
    const { taskId, tasksFilePath, runsDir, cleanup } = createTempEnv({ withState: true, stateOverrides: { branch: 'other-branch' } });
    try {
      const result = runCli(['real-repo-approval-report', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_REPO_APPROVAL_REPORT: 'true',
        RUNS_DIR: runsDir,
      });
      assert.notStrictEqual(result.status, 0);
      assert(result.stderr.includes('State branch mismatch'), `Expected branch mismatch: ${result.stderr}`);
    } finally {
      cleanup();
    }
  });

  test('state pushed_remote not origin refuses', () => {
    const { taskId, tasksFilePath, runsDir, cleanup } = createTempEnv({ withState: true, stateOverrides: { pushed_remote: 'upstream' } });
    try {
      const result = runCli(['real-repo-approval-report', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_REPO_APPROVAL_REPORT: 'true',
        RUNS_DIR: runsDir,
      });
      assert.notStrictEqual(result.status, 0);
      assert(result.stderr.includes('pushed_remote is not origin'), `Expected not origin: ${result.stderr}`);
    } finally {
      cleanup();
    }
  });

  test('state pushed_ref mismatch refuses', () => {
    const { taskId, tasksFilePath, runsDir, cleanup } = createTempEnv({ withState: true, stateOverrides: { pushed_ref: 'other-branch' } });
    try {
      const result = runCli(['real-repo-approval-report', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_REPO_APPROVAL_REPORT: 'true',
        RUNS_DIR: runsDir,
      });
      assert.notStrictEqual(result.status, 0);
      assert(result.stderr.includes('pushed_ref mismatch'), `Expected pushed_ref mismatch: ${result.stderr}`);
    } finally {
      cleanup();
    }
  });

  test('missing commit_sha refuses', () => {
    const { taskId, tasksFilePath, runsDir, cleanup } = createTempEnv({ withState: true, stateOverrides: { commit_sha: '' } });
    try {
      const result = runCli(['real-repo-approval-report', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_REPO_APPROVAL_REPORT: 'true',
        RUNS_DIR: runsDir,
      });
      assert.notStrictEqual(result.status, 0);
      assert(result.stderr.includes('commit_sha is missing'), `Expected missing commit_sha: ${result.stderr}`);
    } finally {
      cleanup();
    }
  });

  test('unknown commit_sha refuses', () => {
    const { taskId, tasksFilePath, runsDir, cleanup } = createTempEnv({ withState: true, stateOverrides: { commit_sha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' } });
    try {
      const result = runCli(['real-repo-approval-report', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_REPO_APPROVAL_REPORT: 'true',
        RUNS_DIR: runsDir,
      });
      assert.notStrictEqual(result.status, 0);
      assert(result.stderr.includes('Commit SHA does not exist'), `Expected unknown commit: ${result.stderr}`);
    } finally {
      cleanup();
    }
  });

  test('valid pushed state writes approval report', () => {
    const { taskId, tasksFilePath, runsDir, cleanup } = createTempEnv({ withState: true });
    try {
      const result = runCli(['real-repo-approval-report', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_REPO_APPROVAL_REPORT: 'true',
        RUNS_DIR: runsDir,
      });
      assert.strictEqual(result.status, 0, `Expected success: ${result.stderr}`);
      assert(result.stderr.includes('Approval report written'), `Expected report written: ${result.stderr}`);
      const reportPath = join(runsDir, taskId, 'approval-report.md');
      assert(existsSync(reportPath), `Expected report file to exist: ${reportPath}`);
    } finally {
      cleanup();
    }
  });

  test('report contains task id', () => {
    const { taskId, tasksFilePath, runsDir, cleanup } = createTempEnv({ withState: true });
    try {
      runCli(['real-repo-approval-report', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_REPO_APPROVAL_REPORT: 'true',
        RUNS_DIR: runsDir,
      });
      const report = readFileSync(join(runsDir, taskId, 'approval-report.md'), 'utf-8');
      assert(report.includes(taskId), `Expected task id in report`);
    } finally {
      cleanup();
    }
  });

  test('report contains base branch', () => {
    const { taskId, tasksFilePath, runsDir, cleanup } = createTempEnv({ withState: true });
    try {
      runCli(['real-repo-approval-report', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_REPO_APPROVAL_REPORT: 'true',
        RUNS_DIR: runsDir,
      });
      const report = readFileSync(join(runsDir, taskId, 'approval-report.md'), 'utf-8');
      assert(report.includes('main'), `Expected base branch in report`);
    } finally {
      cleanup();
    }
  });

  test('report contains work branch', () => {
    const { taskId, tasksFilePath, runsDir, cleanup } = createTempEnv({ withState: true });
    try {
      runCli(['real-repo-approval-report', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_REPO_APPROVAL_REPORT: 'true',
        RUNS_DIR: runsDir,
      });
      const report = readFileSync(join(runsDir, taskId, 'approval-report.md'), 'utf-8');
      assert(report.includes(`ai/${taskId}`), `Expected work branch in report`);
    } finally {
      cleanup();
    }
  });

  test('report contains pushed commit SHA', () => {
    const { taskId, tasksFilePath, runsDir, cleanup } = createTempEnv({ withState: true });
    try {
      runCli(['real-repo-approval-report', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_REPO_APPROVAL_REPORT: 'true',
        RUNS_DIR: runsDir,
      });
      const state = JSON.parse(readFileSync(join(runsDir, taskId, 'state.json'), 'utf-8'));
      const report = readFileSync(join(runsDir, taskId, 'approval-report.md'), 'utf-8');
      assert(report.includes(state.commit_sha), `Expected commit SHA in report`);
    } finally {
      cleanup();
    }
  });

  test('report contains manual review checklist', () => {
    const { taskId, tasksFilePath, runsDir, cleanup } = createTempEnv({ withState: true });
    try {
      runCli(['real-repo-approval-report', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_REPO_APPROVAL_REPORT: 'true',
        RUNS_DIR: runsDir,
      });
      const report = readFileSync(join(runsDir, taskId, 'approval-report.md'), 'utf-8');
      assert(report.includes('Inspect the diff carefully'), `Expected checklist item`);
      assert(report.includes('Do not merge without human review'), `Expected checklist item`);
      assert(report.includes('Do not force push'), `Expected checklist item`);
      assert(report.includes('Do not touch main directly'), `Expected checklist item`);
    } finally {
      cleanup();
    }
  });

  test('report contains This tool did not create a PR', () => {
    const { taskId, tasksFilePath, runsDir, cleanup } = createTempEnv({ withState: true });
    try {
      runCli(['real-repo-approval-report', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_REPO_APPROVAL_REPORT: 'true',
        RUNS_DIR: runsDir,
      });
      const report = readFileSync(join(runsDir, taskId, 'approval-report.md'), 'utf-8');
      assert(report.includes('This tool did not create a PR'), `Expected safety statement`);
    } finally {
      cleanup();
    }
  });

  test('report contains This tool did not merge', () => {
    const { taskId, tasksFilePath, runsDir, cleanup } = createTempEnv({ withState: true });
    try {
      runCli(['real-repo-approval-report', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_REPO_APPROVAL_REPORT: 'true',
        RUNS_DIR: runsDir,
      });
      const report = readFileSync(join(runsDir, taskId, 'approval-report.md'), 'utf-8');
      assert(report.includes('This tool did not merge'), `Expected safety statement`);
    } finally {
      cleanup();
    }
  });

  test('report contains This tool did not checkout or switch branches', () => {
    const { taskId, tasksFilePath, runsDir, cleanup } = createTempEnv({ withState: true });
    try {
      runCli(['real-repo-approval-report', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_REPO_APPROVAL_REPORT: 'true',
        RUNS_DIR: runsDir,
      });
      const report = readFileSync(join(runsDir, taskId, 'approval-report.md'), 'utf-8');
      assert(report.includes('This tool did not checkout or switch branches'), `Expected safety statement`);
    } finally {
      cleanup();
    }
  });

  test('report contains This tool did not touch main', () => {
    const { taskId, tasksFilePath, runsDir, cleanup } = createTempEnv({ withState: true });
    try {
      runCli(['real-repo-approval-report', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_REPO_APPROVAL_REPORT: 'true',
        RUNS_DIR: runsDir,
      });
      const report = readFileSync(join(runsDir, taskId, 'approval-report.md'), 'utf-8');
      assert(report.includes('This tool did not touch main'), `Expected safety statement`);
    } finally {
      cleanup();
    }
  });

  test('report contains This tool did not call provider', () => {
    const { taskId, tasksFilePath, runsDir, cleanup } = createTempEnv({ withState: true });
    try {
      runCli(['real-repo-approval-report', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_REPO_APPROVAL_REPORT: 'true',
        RUNS_DIR: runsDir,
      });
      const report = readFileSync(join(runsDir, taskId, 'approval-report.md'), 'utf-8');
      assert(report.includes('This tool did not call provider'), `Expected safety statement`);
    } finally {
      cleanup();
    }
  });

  test('report contains This tool did not push', () => {
    const { taskId, tasksFilePath, runsDir, cleanup } = createTempEnv({ withState: true });
    try {
      runCli(['real-repo-approval-report', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_REPO_APPROVAL_REPORT: 'true',
        RUNS_DIR: runsDir,
      });
      const report = readFileSync(join(runsDir, taskId, 'approval-report.md'), 'utf-8');
      assert(report.includes('This tool did not push'), `Expected safety statement`);
    } finally {
      cleanup();
    }
  });

  test('report does not contain fake API key', () => {
    const { taskId, tasksFilePath, runsDir, cleanup } = createTempEnv({ withState: true });
    try {
      runCli(['real-repo-approval-report', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_REPO_APPROVAL_REPORT: 'true',
        RUNS_DIR: runsDir,
        KIMI_API_KEY: 'sk-fake-test-key-12345',
      });
      const report = readFileSync(join(runsDir, taskId, 'approval-report.md'), 'utf-8');
      assert(!report.includes('sk-fake-test-key-12345'), `Report must not contain API key`);
    } finally {
      cleanup();
    }
  });

  test('report does not contain remote URL with credentials', () => {
    const { taskId, tasksFilePath, repoPath, runsDir, cleanup } = createTempEnv({ withState: true });
    try {
      spawnSync('git', ['remote', 'set-url', 'origin', 'https://user:pass@github.com/test/repo.git'], {
        cwd: repoPath,
        encoding: 'utf-8',
        shell: false,
      });
      runCli(['real-repo-approval-report', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_REPO_APPROVAL_REPORT: 'true',
        RUNS_DIR: runsDir,
      });
      const report = readFileSync(join(runsDir, taskId, 'approval-report.md'), 'utf-8');
      assert(!report.includes('user:pass'), `Report must not contain credentials`);
    } finally {
      cleanup();
    }
  });

  test('command does not create PR', () => {
    const { taskId, tasksFilePath, runsDir, cleanup } = createTempEnv({ withState: true });
    try {
      const result = runCli(['real-repo-approval-report', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_REPO_APPROVAL_REPORT: 'true',
        RUNS_DIR: runsDir,
      });
      assert(result.stderr.includes('No PR was created'), `Expected no PR created message`);
    } finally {
      cleanup();
    }
  });

  test('command does not merge', () => {
    const { taskId, tasksFilePath, repoPath, runsDir, cleanup } = createTempEnv({ withState: true });
    try {
      const before = spawnSync('git', ['log', '--oneline', 'main'], { cwd: repoPath, encoding: 'utf-8', shell: false }).stdout;
      runCli(['real-repo-approval-report', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_REPO_APPROVAL_REPORT: 'true',
        RUNS_DIR: runsDir,
      });
      const after = spawnSync('git', ['log', '--oneline', 'main'], { cwd: repoPath, encoding: 'utf-8', shell: false }).stdout;
      assert.strictEqual(before, after, 'main must not change');
    } finally {
      cleanup();
    }
  });

  test('command does not checkout/switch', () => {
    const { taskId, tasksFilePath, repoPath, runsDir, cleanup } = createTempEnv({ withState: true });
    try {
      const before = spawnSync('git', ['branch', '--show-current'], { cwd: repoPath, encoding: 'utf-8', shell: false }).stdout.trim();
      runCli(['real-repo-approval-report', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_REPO_APPROVAL_REPORT: 'true',
        RUNS_DIR: runsDir,
      });
      const after = spawnSync('git', ['branch', '--show-current'], { cwd: repoPath, encoding: 'utf-8', shell: false }).stdout.trim();
      assert.strictEqual(before, after, 'Branch must not change');
    } finally {
      cleanup();
    }
  });

  test('command does not push', () => {
    const { taskId, tasksFilePath, repoPath, runsDir, cleanup } = createTempEnv({ withState: true });
    try {
      const before = spawnSync('git', ['log', '--oneline', '--all'], { cwd: repoPath, encoding: 'utf-8', shell: false }).stdout;
      runCli(['real-repo-approval-report', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_REPO_APPROVAL_REPORT: 'true',
        RUNS_DIR: runsDir,
      });
      const after = spawnSync('git', ['log', '--oneline', '--all'], { cwd: repoPath, encoding: 'utf-8', shell: false }).stdout;
      assert.strictEqual(before, after, 'No new commits should be created');
    } finally {
      cleanup();
    }
  });

  test('command does not call provider', () => {
    const { taskId, tasksFilePath, runsDir, cleanup } = createTempEnv({ withState: true });
    try {
      const result = runCli(['real-repo-approval-report', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_REPO_APPROVAL_REPORT: 'true',
        RUNS_DIR: runsDir,
      });
      assert.strictEqual(result.status, 0, `Expected success: ${result.stderr}`);
    } finally {
      cleanup();
    }
  });

  test('command does not write state', () => {
    const { taskId, tasksFilePath, runsDir, cleanup } = createTempEnv({ withState: true });
    try {
      const before = readFileSync(join(runsDir, taskId, 'state.json'), 'utf-8');
      runCli(['real-repo-approval-report', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_REPO_APPROVAL_REPORT: 'true',
        RUNS_DIR: runsDir,
      });
      const after = readFileSync(join(runsDir, taskId, 'state.json'), 'utf-8');
      assert.strictEqual(before, after, 'State must not change');
    } finally {
      cleanup();
    }
  });

  test('command only writes approval-report.md', () => {
    const { taskId, tasksFilePath, runsDir, cleanup } = createTempEnv({ withState: true });
    try {
      runCli(['real-repo-approval-report', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_REPO_APPROVAL_REPORT: 'true',
        RUNS_DIR: runsDir,
      });
      const files = readdirSync(join(runsDir, taskId));
      assert(files.includes('approval-report.md'), `Expected approval-report.md`);
      assert(files.includes('state.json'), `Expected state.json to remain`);
      assert.strictEqual(files.length, 2, `Expected exactly 2 files in run dir, got: ${files.join(', ')}`);
    } finally {
      cleanup();
    }
  });

  test('diff stat unavailable still writes report with warning', () => {
    const { taskId, tasksFilePath, runsDir, cleanup } = createTempEnv({ withState: true, baseBranch: 'nonexistent-base' });
    try {
      const result = runCli(['real-repo-approval-report', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_REPO_APPROVAL_REPORT: 'true',
        RUNS_DIR: runsDir,
      });
      assert.strictEqual(result.status, 0, `Expected success despite diff failure: ${result.stderr}`);
      const report = readFileSync(join(runsDir, taskId, 'approval-report.md'), 'utf-8');
      assert(report.includes('Diff stat unavailable; inspect manually'), `Expected diff unavailable warning`);
    } finally {
      cleanup();
    }
  });

  test('no stack trace in failure paths', () => {
    const { taskId, tasksFilePath, cleanup } = createTempEnv();
    try {
      const result = runCli(['real-repo-approval-report', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_REPO_APPROVAL_REPORT: 'true',
      });
      assert.notStrictEqual(result.status, 0);
      assert(!result.stderr.includes('at '), `Stack trace leaked: ${result.stderr}`);
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
      assert(result.stderr.includes('Real provider run completed'), `Expected run completed: ${result.stderr}`);
    } finally {
      cleanup();
    }
  });

  test('existing readiness behavior unchanged', () => {
    const { taskId, tasksFilePath, repoPath, cleanup } = createTempEnv();
    try {
      const originPath = join(process.cwd(), 'tmp', `apr-r-origin-${Date.now()}`);
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

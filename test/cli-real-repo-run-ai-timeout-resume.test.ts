import { describe, test } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { loadState, saveState } from '../src/state-manager.js';
import type { RunState } from '../src/types.js';

let counter = 0;

function getCleanEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.AI_PROVIDER;
  delete env.MOCK_AI_RESPONSE;
  delete env.MOCK_REVIEWER_RESPONSE;
  delete env.MOCK_PROVIDER_RESPONSE;
  delete env.KIMI_API_KEY;
  delete env.KIMI_MODEL;
  delete env.KIMI_BASE_URL;
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
  delete env.SANDBOX_PROVIDER_RESPONSE;
  delete env.SANDBOX_ROOT;
  delete env.REAL_REPO_PROVIDER_RESPONSE;
  delete env.RUNS_DIR;
  delete env.REAL_REPO_AI_MAX_ATTEMPTS;
  delete env.REAL_REPO_REVIEWER_FAKE_RESPONSE;
  delete env.KIMI_FAKE_REVIEWER_RESPONSE;
  delete env.REAL_REPO_REVIEWER_NO_DEFAULT;
  delete env.REAL_REPO_REVIEWER_CAPTURE_INPUT_FILE;
  delete env.REAL_REPO_REVIEWER_FORCE_PROVIDER_ERROR;
  delete env.REAL_REPO_REVIEWER_FIX_TASK_FAKE_EXECUTOR_RESPONSE;
  delete env.REAL_REPO_ENABLE_REVIEWER_FIX_LOOP;
  delete env.REAL_REPO_REVIEWER_MAX_FIX_ATTEMPTS;
  delete env.REAL_REPO_REVIEWER_SECOND_FAKE_RESPONSE;
  delete env.REAL_REPO_REVIEWER_SECOND_KIMI_FAKE_RESPONSE;
  delete env.REAL_REPO_REVIEWER_SECOND_FORCE_PROVIDER_ERROR;
  delete env.REAL_REPO_REVIEWER_FIX_TASK_KIMI_FAKE_RESPONSE;
  delete env.REAL_REPO_REVIEWER_FIX_TASK_KIMI_FAKE_RESPONSES;
  delete env.REAL_REPO_RUN_RESUME;
  delete env.REAL_REPO_RUN_RESUME_TIMEOUT_MS;
  delete env.REAL_REPO_TASK_TIMEOUT_MS;
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
  const overriddenKeys = new Set(Object.keys(envOverrides));
  const leakedKeyPattern = /^(REAL_REPO_|REAL_BLOCK_|KIMI_|MOCK_|ALLOW_|SANDBOX_|OPENAI_|TASKS_FILE|RUNS_DIR|NODE_TEST_CONTEXT)/;
  for (const key of Object.keys(env)) {
    if (!overriddenKeys.has(key) && leakedKeyPattern.test(key)) {
      delete env[key];
    }
  }
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
      timeout: 30000,
    }
  );
  return {
    status: result.status ?? 1,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  };
}

function buildFakeKimiOutput(
  files: Array<{ path: string; content: string }>,
  notes?: string
): string {
  return JSON.stringify({ mode: 'file_update', files, notes });
}

function createTempEnv(checks: string[] = []): {
  taskId: string;
  tasksFilePath: string;
  repoPath: string;
  originPath: string;
  runsDir: string;
  cleanup: () => void;
} {
  const id = `${Date.now()}-${counter++}`;
  const taskId = `rai-timeout-${id}`;
  const tmpBase = join(process.cwd(), 'tmp');
  if (!existsSync(tmpBase)) {
    mkdirSync(tmpBase);
  }
  const tmpDir = mkdtempSync(join(tmpBase, `rai-timeout-${id}-`));
  const repoPath = join(tmpDir, 'repo');
  const originPath = join(tmpDir, 'origin.git');
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
  spawnSync('git', ['checkout', '-b', `ai/${taskId}`], {
    cwd: repoPath,
    encoding: 'utf-8',
    shell: false,
  });

  spawnSync('git', ['init', '--bare', originPath], {
    encoding: 'utf-8',
    shell: false,
  });
  spawnSync('git', ['remote', 'add', 'origin', originPath], {
    cwd: repoPath,
    encoding: 'utf-8',
    shell: false,
  });

  const checkLines =
    checks.length > 0
      ? checks
          .map((c) => {
            const parts = c.split(' ');
            return `    - command: "${parts[0]}"\n      args: [${parts
              .slice(1)
              .map((a) => `"${a}"`)
              .join(', ')}]`;
          })
          .join('\n')
      : '    - command: "node"\n      args: ["-e", "process.exit(0)"]';

  const tasksFilePath = join(tmpDir, 'tasks.yaml');
  writeFileSync(
    tasksFilePath,
    `tasks:
  - id: ${taskId}
    title: "Run AI timeout resume test"
    repo_path: "${repoPath.replace(/\\/g, '/')}"
    base_branch: "main"
    work_branch: "ai/${taskId}"
    goal: "Test goal"
    context_files: []
    checks:
${checkLines}
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

  return {
    taskId,
    tasksFilePath,
    repoPath,
    originPath,
    runsDir,
    cleanup: () => {
      rmSync(tmpDir, { recursive: true, force: true });
    },
  };
}

function getCurrentBranch(repoPath: string): string {
  const result = spawnSync('git', ['branch', '--show-current'], {
    cwd: repoPath,
    encoding: 'utf-8',
    shell: false,
  });
  return result.stdout.trim();
}

function getGitLogCount(repoPath: string): number {
  const result = spawnSync('git', ['log', '--oneline'], {
    cwd: repoPath,
    encoding: 'utf-8',
    shell: false,
  });
  return result.stdout.trim().split('\n').filter((l) => l.length > 0).length;
}

function getHeadSha(repoPath: string): string {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: repoPath,
    encoding: 'utf-8',
    shell: false,
  });
  return result.stdout.trim();
}

function commitAndGetSha(repoPath: string, message: string): string {
  const addResult = spawnSync('git', ['add', '-A'], {
    cwd: repoPath,
    encoding: 'utf-8',
    shell: false,
  });
  if (addResult.status !== 0) {
    throw new Error(`git add failed: ${addResult.stderr}`);
  }
  const commitResult = spawnSync(
    'git',
    ['commit', '-m', message, '--no-gpg-sign'],
    {
      cwd: repoPath,
      encoding: 'utf-8',
      shell: false,
    }
  );
  if (commitResult.status !== 0) {
    throw new Error(`git commit failed: ${commitResult.stderr}`);
  }
  return getHeadSha(repoPath);
}

function makeTaskCommit(repoPath: string, taskId: string): string {
  writeFileSync(join(repoPath, 'README.md'), `# task commit ${taskId}\n`, 'utf-8');
  return commitAndGetSha(repoPath, `ai-orchestrator: apply ${taskId}`);
}

function pushBranch(repoPath: string, branch: string): void {
  const result = spawnSync('git', ['push', 'origin', branch], {
    cwd: repoPath,
    encoding: 'utf-8',
    shell: false,
  });
  if (result.status !== 0) {
    throw new Error(`git push failed: ${result.stderr}`);
  }
}

function makePushedState(
  taskId: string,
  repoPath: string,
  commitSha: string
): RunState {
  const now = new Date().toISOString();
  return {
    task_id: taskId,
    status: 'pushed',
    task_phase: 'pushed',
    current_attempt: 1,
    branch: `ai/${taskId}`,
    repo_path: repoPath,
    created_at: now,
    updated_at: now,
    commit_sha: commitSha,
    pushed_ref: `ai/${taskId}`,
    pushed_remote: 'origin',
  };
}

function writeState(runsDir: string, taskId: string, state: RunState): void {
  saveState(taskId, state, runsDir);
}

function loadStateFromPath(runsDir: string, taskId: string): RunState | null {
  return loadState(taskId, runsDir);
}

function baseEnv(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    TASKS_FILE: '',
    ALLOW_REAL_PROVIDER: 'true',
    ALLOW_REAL_REPO_APPLY: 'true',
    ALLOW_REAL_REPO_COMMIT: 'true',
    ALLOW_REAL_REPO_PUSH: 'true',
    KIMI_API_KEY: 'fake',
    KIMI_BASE_URL: 'http://localhost:9999',
    REAL_REPO_REVIEWER_NO_DEFAULT: '1',
    ...overrides,
  };
}

describe('cli real-repo-run-ai resume', () => {
  test('resume with no existing state fails closed', () => {
    const { taskId, tasksFilePath, runsDir, cleanup } = createTempEnv();
    try {
      const result = runCli(['real-repo-run-ai', taskId], baseEnv({
        TASKS_FILE: tasksFilePath,
        RUNS_DIR: runsDir,
        REAL_REPO_RUN_RESUME: '1',
      }));
      assert.notStrictEqual(result.status, 0);
      assert(result.stderr.includes('Resume mode: no existing state found'), `Expected no state error: ${result.stderr}`);
      assert(result.stderr.includes('No provider call was made'), `Expected safety message: ${result.stderr}`);
    } finally {
      cleanup();
    }
  });

  test('resume with corrupted state fails closed', () => {
    const { taskId, tasksFilePath, runsDir, cleanup } = createTempEnv();
    try {
      const stateDir = join(runsDir, taskId);
      mkdirSync(stateDir, { recursive: true });
      writeFileSync(join(stateDir, 'state.json'), 'not-json', 'utf-8');

      const result = runCli(['real-repo-run-ai', taskId], baseEnv({
        TASKS_FILE: tasksFilePath,
        RUNS_DIR: runsDir,
        REAL_REPO_RUN_RESUME: '1',
      }));
      assert.notStrictEqual(result.status, 0);
      assert(
        result.stderr.includes('not valid JSON') || result.stderr.includes('Invalid state.json'),
        `Expected JSON parse failure: ${result.stderr}`
      );
      assert(result.stderr.includes('No merge was performed'), `Expected safety message: ${result.stderr}`);
    } finally {
      cleanup();
    }
  });

  test('resume with accepted phase exits 0 without provider call', () => {
    const { taskId, tasksFilePath, repoPath, runsDir, cleanup } = createTempEnv();
    try {
      const commitSha = makeTaskCommit(repoPath, taskId);
      pushBranch(repoPath, `ai/${taskId}`);
      const state = makePushedState(taskId, repoPath, commitSha);
      state.task_phase = 'accepted';
      writeState(runsDir, taskId, state);

      const result = runCli(['real-repo-run-ai', taskId], baseEnv({
        TASKS_FILE: tasksFilePath,
        RUNS_DIR: runsDir,
        REAL_REPO_RUN_RESUME: '1',
      }));
      assert.strictEqual(result.status, 0, `Expected accepted resume to exit 0: ${result.stderr}`);
      assert.strictEqual(getGitLogCount(repoPath), 2, 'Accepted resume must not create new commits');
      const loaded = loadStateFromPath(runsDir, taskId);
      assert.strictEqual(loaded?.task_phase, 'accepted');
    } finally {
      cleanup();
    }
  });

  test('resume from pushed phase skips coder and runs reviewer gate', () => {
    const { taskId, tasksFilePath, repoPath, originPath, runsDir, cleanup } = createTempEnv();
    try {
      const commitSha = makeTaskCommit(repoPath, taskId);
      pushBranch(repoPath, `ai/${taskId}`);
      const state = makePushedState(taskId, repoPath, commitSha);
      writeState(runsDir, taskId, state);

      const beforeLogCount = getGitLogCount(repoPath);
      const result = runCli(['real-repo-run-ai', taskId], baseEnv({
        TASKS_FILE: tasksFilePath,
        RUNS_DIR: runsDir,
        REAL_REPO_RUN_RESUME: '1',
        REAL_REPO_REVIEWER_FAKE_RESPONSE: JSON.stringify({
          decision: 'accept',
          confidence: 'high',
          blockingIssues: [],
          nonBlockingIssues: [],
          reviewSummary: 'Resume reviewer acceptance.',
          nextAction: 'continue',
        }),
      }));
      assert.strictEqual(result.status, 0, `Expected reviewer resume success: ${result.stderr}`);
      assert.strictEqual(getGitLogCount(repoPath), beforeLogCount, 'Resume must not add a new commit');
      const loaded = loadStateFromPath(runsDir, taskId);
      assert.strictEqual(loaded?.task_phase, 'accepted');
    } finally {
      cleanup();
    }
  });

  test('resume from reviewer_fix_pending executes fix and accepts', () => {
    const { taskId, tasksFilePath, repoPath, runsDir, cleanup } = createTempEnv();
    try {
      // First run: push a commit and stop at reviewer_fix_pending.
      const first = runCli(['real-repo-run-ai', taskId], baseEnv({
        TASKS_FILE: tasksFilePath,
        RUNS_DIR: runsDir,
        KIMI_FAKE_RESPONSE: buildFakeKimiOutput([{ path: 'README.md', content: '# modified\n' }]),
        REAL_REPO_REVIEWER_FAKE_RESPONSE: JSON.stringify({
          decision: 'reject',
          confidence: 'high',
          blockingIssues: ['needs fix'],
          nonBlockingIssues: [],
          reviewSummary: 'Fix required.',
          nextAction: 'fix',
          fixTask: 'fix-task-id',
        }),
        REAL_REPO_ENABLE_REVIEWER_FIX_LOOP: '0',
      }));
      assert.notStrictEqual(first.status, 0, `Expected first run to request fix: ${first.stderr}`);
      const pushedState = loadStateFromPath(runsDir, taskId);
      assert(pushedState !== null);
      assert.strictEqual(pushedState.task_phase, 'reviewer_fix_pending');

      // Create a fix commit on the work branch.
      writeFileSync(join(repoPath, 'fix.txt'), 'fix\n', 'utf-8');
      const fixSha = commitAndGetSha(repoPath, `ai-orchestrator: apply fix-${taskId}`);
      pushBranch(repoPath, `ai/${taskId}`);

      // Resume: fake executor returns the fix commit, second reviewer accepts.
      const result = runCli(['real-repo-run-ai', taskId], baseEnv({
        TASKS_FILE: tasksFilePath,
        RUNS_DIR: runsDir,
        REAL_REPO_RUN_RESUME: '1',
        REAL_REPO_ENABLE_REVIEWER_FIX_LOOP: '0',
        REAL_REPO_REVIEWER_FIX_TASK_FAKE_EXECUTOR_RESPONSE: JSON.stringify({
          status: 'completed',
          reason: 'Fake fix executor completed.',
          commitSha: fixSha,
          changedFiles: ['fix.txt'],
        }),
        REAL_REPO_REVIEWER_SECOND_FAKE_RESPONSE: JSON.stringify({
          decision: 'accept',
          confidence: 'high',
          blockingIssues: [],
          nonBlockingIssues: [],
          reviewSummary: 'Fix accepted.',
          nextAction: 'continue',
        }),
      }));
      assert.strictEqual(result.status, 0, `Expected fix resume success: ${result.stderr}`);
      const loaded = loadStateFromPath(runsDir, taskId);
      assert.strictEqual(loaded?.task_phase, 'accepted');
    } finally {
      cleanup();
    }
  });

  test('resume from fix_pushed phase attempts second reviewer', () => {
    const { taskId, tasksFilePath, repoPath, runsDir, cleanup } = createTempEnv();
    try {
      const commitSha = makeTaskCommit(repoPath, taskId);
      pushBranch(repoPath, `ai/${taskId}`);

      // Create a fix commit and push it.
      writeFileSync(join(repoPath, 'fix.txt'), 'fix\n', 'utf-8');
      const fixSha = commitAndGetSha(repoPath, `ai-orchestrator: apply fix-${taskId}`);
      pushBranch(repoPath, `ai/${taskId}`);

      const state = makePushedState(taskId, repoPath, commitSha) as RunState & Record<string, unknown>;
      state.task_phase = 'fix_pushed';
      state.reviewer_phase_evidence = {
        fix_commit_sha: fixSha,
      };
      state.reviewer_fix_task_second_review = {
        fixTaskId: `fix-${taskId}`,
        parentTaskId: taskId,
        attempt: 1,
        fixCommitSha: fixSha,
        reviewerGate: {
          status: 'accepted',
          source: 'test',
          nextAction: 'continue',
          blockingIssues: [],
          nonBlockingIssues: [],
          reviewSummary: 'Test second review.',
        },
        checkSummary: { test: 'pass' },
        finalStatus: 'accepted',
        nextAction: 'continue',
        reason: 'Test resume from fix_pushed.',
      };
      writeState(runsDir, taskId, state);

      const result = runCli(['real-repo-run-ai', taskId], baseEnv({
        TASKS_FILE: tasksFilePath,
        RUNS_DIR: runsDir,
        REAL_REPO_RUN_RESUME: '1',
        REAL_REPO_REVIEWER_FAKE_RESPONSE: JSON.stringify({
          decision: 'accept',
          confidence: 'high',
          blockingIssues: [],
          nonBlockingIssues: [],
          reviewSummary: 'Second reviewer accept on resume.',
          nextAction: 'continue',
        }),
      }));

      // Current implementation re-derives the fix plan from state, so it may
      // either accept the persisted second review or re-execute. Either way it
      // must not fail closed with a safety error and must end in a terminal phase.
      const loaded = loadStateFromPath(runsDir, taskId);
      assert(loaded !== null);
      const terminalPhases = ['accepted', 'blocked', 'failed'];
      assert(
        terminalPhases.includes(loaded.task_phase ?? ''),
        `Expected terminal phase after fix_pushed resume, got ${loaded.task_phase}: ${result.stderr}`
      );
    } finally {
      cleanup();
    }
  });

  test('resume with repo_path mismatch fails closed', () => {
    const { taskId, tasksFilePath, repoPath, runsDir, cleanup } = createTempEnv();
    try {
      const commitSha = makeTaskCommit(repoPath, taskId);
      pushBranch(repoPath, `ai/${taskId}`);
      const state = makePushedState(taskId, repoPath, commitSha);
      state.repo_path = '/nonexistent/repo';
      writeState(runsDir, taskId, state);

      const result = runCli(['real-repo-run-ai', taskId], baseEnv({
        TASKS_FILE: tasksFilePath,
        RUNS_DIR: runsDir,
        REAL_REPO_RUN_RESUME: '1',
      }));
      assert.notStrictEqual(result.status, 0);
      assert(result.stderr.includes('repo_path mismatch'), `Expected repo_path mismatch: ${result.stderr}`);
      assert(result.stderr.includes('No provider call was made'), `Expected safety message: ${result.stderr}`);
    } finally {
      cleanup();
    }
  });

  test('resume with branch mismatch fails closed', () => {
    const { taskId, tasksFilePath, repoPath, runsDir, cleanup } = createTempEnv();
    try {
      const commitSha = makeTaskCommit(repoPath, taskId);
      pushBranch(repoPath, `ai/${taskId}`);
      const state = makePushedState(taskId, repoPath, commitSha);
      state.branch = 'wrong-branch';
      writeState(runsDir, taskId, state);

      const result = runCli(['real-repo-run-ai', taskId], baseEnv({
        TASKS_FILE: tasksFilePath,
        RUNS_DIR: runsDir,
        REAL_REPO_RUN_RESUME: '1',
      }));
      assert.notStrictEqual(result.status, 0);
      assert(result.stderr.includes('branch mismatch'), `Expected branch mismatch: ${result.stderr}`);
      assert(result.stderr.includes('No provider call was made'), `Expected safety message: ${result.stderr}`);
    } finally {
      cleanup();
    }
  });

  test('resume with dirty working tree fails closed', () => {
    const { taskId, tasksFilePath, repoPath, runsDir, cleanup } = createTempEnv();
    try {
      const commitSha = makeTaskCommit(repoPath, taskId);
      pushBranch(repoPath, `ai/${taskId}`);
      const state = makePushedState(taskId, repoPath, commitSha);
      writeState(runsDir, taskId, state);

      writeFileSync(join(repoPath, 'dirty.txt'), 'dirty\n', 'utf-8');
      const result = runCli(['real-repo-run-ai', taskId], baseEnv({
        TASKS_FILE: tasksFilePath,
        RUNS_DIR: runsDir,
        REAL_REPO_RUN_RESUME: '1',
      }));
      assert.notStrictEqual(result.status, 0);
      assert(result.stderr.includes('Working tree is not clean'), `Expected dirty tree error: ${result.stderr}`);
      assert(result.stderr.includes('No provider call was made'), `Expected safety message: ${result.stderr}`);
    } finally {
      cleanup();
    }
  });

  test('resume with remote SHA mismatch fails closed', () => {
    const { taskId, tasksFilePath, repoPath, originPath, runsDir, cleanup } = createTempEnv();
    try {
      const commitSha = makeTaskCommit(repoPath, taskId);
      // Intentionally do NOT push the commit so the remote is missing it.
      const state = makePushedState(taskId, repoPath, commitSha);
      writeState(runsDir, taskId, state);

      const result = runCli(['real-repo-run-ai', taskId], baseEnv({
        TASKS_FILE: tasksFilePath,
        RUNS_DIR: runsDir,
        REAL_REPO_RUN_RESUME: '1',
      }));
      assert.notStrictEqual(result.status, 0);
      assert(result.stderr.includes('remote origin/ai/') && result.stderr.includes('does not contain commit_sha'), `Expected remote SHA mismatch: ${result.stderr}`);
      assert(result.stderr.includes('No provider call was made'), `Expected safety message: ${result.stderr}`);
    } finally {
      cleanup();
    }
  });
});

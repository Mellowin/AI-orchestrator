#!/usr/bin/env node
/**
 * Block follow-up drill (Stage 18.26h adaptation).
 *
 * Stage 18.26 moved the reviewer gate BEFORE the push: a task blocked for
 * human review never produces a pushed commit, so the block runner records
 * `finalStatus: 'blocked'` task results instead of
 * `rollbackPolicy: 'post_push_preserve_for_human'` records, and the
 * `real-block-follow-up` command finds no post-push preserved commits.
 *
 * This adaptation preserves the drill's SAFETY SEMANTICS with the current
 * architecture:
 *
 *   - blocked tasks are visible in the block state for a human (report-only);
 *   - the follow-up command never invents follow-ups for pre-push blocks and
 *     never mutates the repository;
 *   - follow-up creation is vacuously safe (no files) when there are no
 *     post-push preserved commits;
 *   - reviewer evidence containing secrets is redacted everywhere;
 *   - corrupted block state is refused fail-closed.
 *
 * All scenarios use local bare remotes and fake provider responses only.
 * No live provider calls are made.
 *
 * Env:
 *   BLOCK_FOLLOW_UP_DRILL_KEEP_TEMP=1   preserve the temp workspace
 *   BLOCK_FOLLOW_UP_DRILL_FORCE_FAIL=A  force scenario A to report FAIL
 *   --workspace <abs path>
 *   --list-scenarios
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = resolve(__dirname, '..');
const CLI_SCRIPT = join(PROJECT_ROOT, 'src', 'cli.ts');
const TSX_CLI = join(PROJECT_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const RUNNER_BIN = process.execPath;

const FAKE_API_KEY = 'sk-drill-fake-key-12345678901234567890';
const FAKE_BASE_URL = 'http://localhost:9999';

const SECRET_API_KEY = 'secret-block-follow-up-key';
const SECRET_TOKEN = 'secret-block-follow-up-token';

function parseArgs(argv) {
  const args = { workspace: null, listScenarios: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--workspace') {
      const next = argv[i + 1];
      if (next == null) throw new Error('Missing value for --workspace');
      args.workspace = resolve(next);
      i++;
    } else if (arg === '--list-scenarios') {
      args.listScenarios = true;
    }
  }
  return args;
}

function redactOutput(input) {
  if (typeof input !== 'string') return '';
  return input
    .replace(/sk-[a-zA-Z0-9]{20,}/g, 'sk-***')
    .replace(/ghp_[a-zA-Z0-9]{36}/g, 'ghp_***')
    .replace(/github_pat_[a-zA-Z0-9_]{22,}/g, 'github_pat_***')
    .replace(/Bearer\s+[a-zA-Z0-9_\-]{8,}/g, 'Bearer ***')
    .replace(/([a-zA-Z_]*(?:api[_-]?key|token|password|secret))\s*[:=]\s*[^\s\r\n'"]+/gi, '$1=***');
}

function runGit(cwd, args, env = process.env) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', shell: false, env });
  return {
    status: result.status ?? 1,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  };
}

function runCli(args, envOverrides) {
  const env = { ...getCleanEnv(), ...envOverrides };
  const result = spawnSync(
    RUNNER_BIN,
    [TSX_CLI, CLI_SCRIPT, ...args],
    { cwd: PROJECT_ROOT, encoding: 'utf8', shell: false, env, timeout: 120000 }
  );
  return {
    status: result.status ?? 1,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  };
}

function getCleanEnv() {
  const env = { ...process.env };
  const keysToDelete = [
    'AI_PROVIDER', 'MOCK_AI_RESPONSE', 'MOCK_REVIEWER_RESPONSE', 'MOCK_PROVIDER_RESPONSE',
    'KIMI_API_KEY', 'KIMI_MODEL', 'KIMI_BASE_URL', 'KIMI_USER_AGENT', 'KIMI_FAKE_RESPONSE', 'KIMI_FAKE_RESPONSES',
    'OPENAI_API_KEY', 'MOCK_AI', 'ALLOW_REAL_PROVIDER', 'ALLOW_REAL_PROVIDER_RUN',
    'ALLOW_SANDBOX_APPLY_PREVIEW', 'ALLOW_REAL_REPO_APPLY', 'ALLOW_REAL_REPO_COMMIT', 'ALLOW_REAL_REPO_PUSH',
    'SANDBOX_PROVIDER_RESPONSE', 'SANDBOX_ROOT', 'REAL_REPO_PROVIDER_RESPONSE', 'RUNS_DIR',
    'REAL_REPO_AI_MAX_ATTEMPTS', 'REAL_REPO_REVIEWER_FAKE_RESPONSE', 'REAL_REPO_REVIEWER_NO_DEFAULT',
    'REAL_REPO_REVIEWER_CAPTURE_INPUT_FILE', 'REAL_REPO_REVIEWER_FORCE_PROVIDER_ERROR',
    'REAL_REPO_REVIEWER_FIX_TASK_FAKE_EXECUTOR_RESPONSE', 'REAL_REPO_ENABLE_REVIEWER_FIX_LOOP',
    'REAL_REPO_REVIEWER_MAX_FIX_ATTEMPTS', 'REAL_REPO_REVIEWER_SECOND_FAKE_RESPONSE',
    'REAL_REPO_REVIEWER_SECOND_KIMI_FAKE_RESPONSE', 'REAL_REPO_REVIEWER_FIX_TASK_KIMI_FAKE_RESPONSE',
    'REAL_REPO_REVIEWER_FIX_TASK_KIMI_FAKE_RESPONSES', 'REAL_REPO_REVIEWER_PARSE_RETRIES',
    'REAL_REPO_RUN_RESUME', 'REAL_REPO_RUN_RESUME_TIMEOUT_MS',
  ];
  for (const key of keysToDelete) delete env[key];
  return env;
}

function buildFakeKimiOutput(files, notes = '') {
  return JSON.stringify({ mode: 'file_update', files, notes });
}

function buildFakeReviewerResponse({
  decision = 'accept',
  confidence = 'high',
  blockingIssues = [],
  nonBlockingIssues = [],
  reviewSummary = 'Drill reviewer response',
  nextAction = 'continue',
  fixTask,
}) {
  return JSON.stringify({ decision, confidence, blockingIssues, nonBlockingIssues, reviewSummary, nextAction, fixTask });
}

function createWorkspace(baseDir) {
  return mkdtempSync(join(baseDir, 'block-follow-up-drill-'));
}

function createScenarioWorkspace(workspace, scenarioName) {
  const dir = join(workspace, scenarioName);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function isPathInsideOrEqual(child, parent) {
  const rChild = resolve(child);
  const rParent = resolve(parent);
  if (rChild === rParent) return true;
  return rChild.toLowerCase().startsWith(rParent.toLowerCase() + '\\') || rChild.startsWith(rParent + '/');
}

function setupRepo(scenarioDir, branch) {
  const repoPath = join(scenarioDir, 'repo');
  const originPath = join(scenarioDir, 'origin.git');
  const runsDir = join(scenarioDir, 'runs');
  mkdirSync(repoPath, { recursive: true });
  mkdirSync(originPath, { recursive: true });
  mkdirSync(runsDir, { recursive: true });

  runGit(repoPath, ['init']);
  runGit(repoPath, ['config', 'user.email', 'drill@example.com']);
  runGit(repoPath, ['config', 'user.name', 'Drill Bot']);
  writeFileSync(join(repoPath, 'README.md'), '# hello\n', 'utf8');
  runGit(repoPath, ['add', '.']);
  runGit(repoPath, ['commit', '-m', 'init', '--no-gpg-sign']);
  runGit(repoPath, ['branch', '-m', 'main']);
  runGit(repoPath, ['checkout', '-b', branch]);

  runGit(originPath, ['init', '--bare']);
  runGit(repoPath, ['remote', 'add', 'origin', originPath]);

  return { repoPath, originPath, runsDir };
}

function writeBlockFile(blockPath, { blockId, repoPath, branch, tasks }) {
  writeFileSync(
    blockPath,
    JSON.stringify(
      {
        block_id: blockId,
        title: `Drill block ${blockId}`,
        repo_path: resolve(repoPath).replace(/\\/g, '/'),
        base_branch: 'main',
        work_branch: branch,
        providers: {
          coder: { provider: 'kimi', model: 'kimi-k2.6' },
          reviewer: { provider: 'kimi', model: 'kimi-k2.6' },
        },
        review_policy: {
          require_deterministic_checks: true,
          max_fix_attempts: 1,
          reviewer_mode: 'single',
        },
        tasks: tasks.map((t) => ({
          task_id: t.taskId,
          title: t.title,
          goal: t.goal,
          allowed_files: t.allowedFiles,
          denied_files: ['.env', '.env.*', 'node_modules/**'],
          max_lines_changed: 150,
          checks: [{ command: 'node', args: ['-e', 'process.exit(0)'] }],
        })),      },
      null,
      2
    ),
    'utf8'
  );
}

function baseEnv({ blockPath, runsDir }) {
  return {
    BLOCK_FILE: blockPath,
    RUNS_DIR: runsDir,
    ALLOW_REAL_PROVIDER: 'true',
    ALLOW_REAL_BLOCK_RUN_AI: 'true',
    ALLOW_REAL_REPO_APPLY: 'true',
    ALLOW_REAL_REPO_COMMIT: 'true',
    ALLOW_REAL_REPO_PUSH: 'true',
    REAL_REPO_AI_MAX_ATTEMPTS: '1',
    KIMI_API_KEY: FAKE_API_KEY,
    KIMI_BASE_URL: FAKE_BASE_URL,
  };
}

function getHeadSha(repoPath) {
  const result = runGit(repoPath, ['rev-parse', '--verify', 'HEAD']);
  if (result.status !== 0) return null;
  return result.stdout.trim();
}

function isWorkingTreeClean(repoPath) {
  const result = runGit(repoPath, ['status', '--porcelain']);
  if (result.status !== 0) return false;
  return result.stdout.trim().length === 0;
}

function loadBlockState(runsDir, blockId) {
  const statePath = join(runsDir, 'block', blockId, 'state.json');
  if (!existsSync(statePath)) return null;
  return JSON.parse(readFileSync(statePath, 'utf8'));
}

function saveBlockState(runsDir, blockId, state) {
  const statePath = join(runsDir, 'block', blockId, 'state.json');
  writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf8');
}

function getChildRunDir(runsDir, taskId) {
  return join(runsDir, 'tasks', taskId);
}

function loadChildState(runsDir, taskId) {
  const statePath = join(getChildRunDir(runsDir, taskId), 'state.json');
  if (!existsSync(statePath)) return null;
  return JSON.parse(readFileSync(statePath, 'utf8'));
}

function saveChildState(runsDir, taskId, state) {
  const statePath = join(getChildRunDir(runsDir, taskId), 'state.json');
  writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf8');
}

function buildSingleTaskYaml({ taskId, title, repoPath, baseBranch, workBranch, goal, allowedFiles }) {
  const taskObject = {
    tasks: [
      {
        id: taskId,
        title,
        repo_path: resolve(repoPath).replace(/\\/g, '/'),
        base_branch: baseBranch,
        work_branch: workBranch,
        goal,
        context_files: allowedFiles.filter((file) => existsSync(resolve(repoPath, file))),
        checks: [{ command: 'node', args: ['-e', 'process.exit(0)'] }],
        guardrails: {
          allow_modify: allowedFiles,
          deny_modify: ['.env', '.env.*', 'node_modules/**'],
          max_lines_changed: 150,
          require_tests: false,
          auto_commit: false,
          auto_push: false,
          auto_merge: false,
        },
      },
    ],
  };
  return JSON.stringify(taskObject, null, 2);
}

function runBlock(blockPath, env) {
  return runCli(['real-block-run-ai', blockPath], env);
}

function runRepoTask({ taskId, tasksFilePath, runsDir, kimiResponse, reviewerResponse }) {
  const env = {
    ...getCleanEnv(),
    TASKS_FILE: tasksFilePath,
    RUNS_DIR: join(runsDir, 'tasks'),
    ALLOW_REAL_PROVIDER: 'true',
    ALLOW_REAL_REPO_APPLY: 'true',
    ALLOW_REAL_REPO_COMMIT: 'true',
    ALLOW_REAL_REPO_PUSH: 'true',
    REAL_REPO_ENABLE_REVIEWER_FIX_LOOP: '0',
    REAL_REPO_AI_MAX_ATTEMPTS: '1',
    REAL_REPO_REVIEWER_MAX_FIX_ATTEMPTS: '1',
    KIMI_API_KEY: FAKE_API_KEY,
    KIMI_BASE_URL: FAKE_BASE_URL,
  };
  if (kimiResponse !== undefined) env.KIMI_FAKE_RESPONSE = kimiResponse;
  if (reviewerResponse !== undefined) env.REAL_REPO_REVIEWER_FAKE_RESPONSE = reviewerResponse;
  return runCli(['real-repo-run-ai', taskId], env);
}

function runBlockFollowUp(blockId, runsDir, flag) {
  const args = ['real-block-follow-up', blockId];
  if (flag) args.push(flag);
  return runCli(args, { RUNS_DIR: runsDir });
}

/**
 * Count tasks blocked for human review in the current block state model:
 * the block runner records finalStatus 'blocked' / nextAction 'block', or a
 * legacy post_push_preserve_for_human record (never produced anymore, kept
 * for backward-compatible counting).
 */
function getManualTaskCount(blockState) {
  if (!blockState || !Array.isArray(blockState.taskResults)) return 0;
  return blockState.taskResults.filter(
    (r) =>
      r.rollbackPolicy === 'post_push_preserve_for_human' ||
      (r.finalStatus === 'blocked' && r.nextAction === 'block')
  ).length;
}

function countFollowUpFiles(runsDir) {
  let count = 0;
  const tasksDir = join(runsDir, 'tasks');
  if (!existsSync(tasksDir)) return 0;
  for (const entry of readdirSync(tasksDir)) {
    const taskDir = join(tasksDir, entry);
    for (const file of readdirSync(taskDir)) {
      if (file.startsWith('follow-up-') && file.endsWith('.yaml')) count += 1;
    }
  }
  return count;
}

function runScenarioA(scenarioDir, blockId) {
  const branch = `ai/${blockId}`;
  const { repoPath, runsDir } = setupRepo(scenarioDir, branch);
  const blockPath = join(scenarioDir, 'block.json');
  writeBlockFile(blockPath, {
    blockId,
    repoPath,
    branch,
    tasks: [
      { taskId: 'task_1', title: 'Accepted task', goal: 'Update README.', allowedFiles: ['README.md'] },
      { taskId: 'task_2', title: 'Manual follow-up task', goal: 'Update feature.', allowedFiles: ['feature.txt'] },
    ],
  });

  const env = {
    ...baseEnv({ blockPath, runsDir }),
    REAL_BLOCK_TASK_KIMI_FAKE_RESPONSES: JSON.stringify([
      buildFakeKimiOutput([{ path: 'README.md', content: '# hello\nupdated\n' }]),
      buildFakeKimiOutput([{ path: 'feature.txt', content: 'feature\nupdated\n' }]),
    ]),
    REAL_BLOCK_TASK_REVIEWER_FAKE_RESPONSES: JSON.stringify([
      buildFakeReviewerResponse({ decision: 'accept', nextAction: 'continue', reviewSummary: 'Task 1 accepted' }),
      buildFakeReviewerResponse({
        decision: 'block_for_human',
        nextAction: 'block',
        reviewSummary: 'Task 2 needs human review',
        blockingIssues: ['needs human review'],
      }),
    ]),
  };

  const runResult = runBlock(blockPath, env);
  const runOutput = `${runResult.stdout}\n${runResult.stderr}`;
  if (runResult.status === 0) {
    return { name: 'A. One blocked task report-only', pass: false, output: runOutput, manualTaskCount: 0, followUpFilesCreated: 0, repoUnchanged: false, redactionPassed: 'n/a' };
  }

  const headAfterBlockRun = getHeadSha(repoPath);
  const blockState = loadBlockState(runsDir, blockId);
  const followUpResult = runBlockFollowUp(blockId, runsDir, '--report-only');
  const followUpOutput = `${followUpResult.stdout}\n${followUpResult.stderr}`;
  const headAfterFollowUp = getHeadSha(repoPath);

  const manualCount = getManualTaskCount(blockState);
  const repoUnchanged = headAfterFollowUp === headAfterBlockRun && isWorkingTreeClean(repoPath);
  const task2Result = blockState?.taskResults?.find((r) => r.taskId === 'task_2');

  // The blocked task is recorded for a human in the block state; the follow-up
  // command finds no post-push preserved commits (the block happened
  // pre-push) and must not claim or mutate anything.
  const pass =
    followUpResult.status === 0 &&
    manualCount === 1 &&
    task2Result?.finalStatus === 'blocked' &&
    task2Result?.reviewerGateStatus === 'blocked' &&
    task2Result?.pushed === false &&
    followUpOutput.includes('Tasks needing human follow-up: 0') &&
    followUpOutput.includes('No tasks require post-push human follow-up') &&
    followUpOutput.includes('No repository mutation was performed') &&
    repoUnchanged;

  return {
    name: 'A. One blocked task report-only',
    pass,
    output: pass ? followUpOutput : `${runOutput}\n${followUpOutput}`,
    manualTaskCount: manualCount,
    followUpFilesCreated: 0,
    repoUnchanged,
    redactionPassed: 'n/a',
  };
}

function runScenarioB(scenarioDir, blockId) {
  const branch = `ai/${blockId}`;
  const { repoPath, runsDir } = setupRepo(scenarioDir, branch);
  const blockPath = join(scenarioDir, 'block.json');
  writeBlockFile(blockPath, {
    blockId,
    repoPath,
    branch,
    tasks: [
      { taskId: 'task_1', title: 'Accepted task', goal: 'Update README.', allowedFiles: ['README.md'] },
      { taskId: 'task_2', title: 'Manual task A', goal: 'Update feature.', allowedFiles: ['feature.txt'] },
      { taskId: 'task_3', title: 'Manual task B', goal: 'Update feature2.', allowedFiles: ['feature2.txt'] },
    ],
  });

  const env = {
    ...baseEnv({ blockPath, runsDir }),
    REAL_BLOCK_TASK_KIMI_FAKE_RESPONSES: JSON.stringify([
      buildFakeKimiOutput([{ path: 'README.md', content: '# hello\nupdated\n' }]),
      buildFakeKimiOutput([{ path: 'feature.txt', content: 'feature\nupdated\n' }]),
      buildFakeKimiOutput([{ path: 'feature2.txt', content: 'feature2\nupdated\n' }]),
    ]),
    REAL_BLOCK_TASK_REVIEWER_FAKE_RESPONSES: JSON.stringify([
      buildFakeReviewerResponse({ decision: 'accept', nextAction: 'continue', reviewSummary: 'Task 1 accepted' }),
      buildFakeReviewerResponse({
        decision: 'block_for_human',
        nextAction: 'block',
        reviewSummary: 'Task 2 needs human review',
        blockingIssues: ['needs human review'],
      }),
      buildFakeReviewerResponse({
        decision: 'block_for_human',
        nextAction: 'block',
        reviewSummary: 'Task 3 needs human review',
        blockingIssues: ['needs human review'],
      }),
    ]),
  };

  const runResult = runBlock(blockPath, env);
  const runOutput = `${runResult.stdout}\n${runResult.stderr}`;
  if (runResult.status === 0) {
    return { name: 'B. Multiple blocked tasks report-only', pass: false, output: runOutput, manualTaskCount: 0, followUpFilesCreated: 0, repoUnchanged: false, redactionPassed: 'n/a' };
  }

  // The block runner stops after the first non-accepted task, so task_3 was
  // not run. Run task_3 separately against the same repo/branch so the block
  // state records a second blocked task.
  const tasksFilePath = join(scenarioDir, 'task_3.tasks.json');
  writeFileSync(
    tasksFilePath,
    buildSingleTaskYaml({
      taskId: 'task_3',
      title: 'Manual task B',
      repoPath,
      baseBranch: 'main',
      workBranch: branch,
      goal: 'Update feature2.',
      allowedFiles: ['feature2.txt'],
    }),
    'utf8'
  );

  const task3Run = runRepoTask({
    taskId: 'task_3',
    tasksFilePath,
    runsDir,
    kimiResponse: buildFakeKimiOutput([{ path: 'feature2.txt', content: 'feature2\nupdated\n' }]),
    reviewerResponse: buildFakeReviewerResponse({
      decision: 'block_for_human',
      nextAction: 'block',
      reviewSummary: 'Task 3 needs human review',
      blockingIssues: ['needs human review'],
    }),
  });
  const task3Output = `${task3Run.stdout}\n${task3Run.stderr}`;
  if (task3Run.status === 0) {
    return { name: 'B. Multiple blocked tasks report-only', pass: false, output: task3Output, manualTaskCount: 0, followUpFilesCreated: 0, repoUnchanged: false, redactionPassed: 'n/a' };
  }

  // Record task_3 as a blocked manual task in the block state (mirrors what a
  // human operator would do after handling the stopped block).
  const blockState = loadBlockState(runsDir, blockId);
  if (!blockState || !Array.isArray(blockState.taskResults)) {
    return { name: 'B. Multiple blocked tasks report-only', pass: false, output: 'block state missing taskResults', manualTaskCount: 0, followUpFilesCreated: 0, repoUnchanged: false, redactionPassed: 'n/a' };
  }
  if (!blockState.taskResults.some((r) => r.taskId === 'task_3')) {
    blockState.taskResults.push({
      taskId: 'task_3',
      title: 'Manual task B',
      status: 'blocked',
      finalStatus: 'blocked',
      nextAction: 'block',
      childStateTaskId: 'task_3',
      pushed: false,
      reviewerGateStatus: 'blocked',
    });
    saveBlockState(runsDir, blockId, blockState);
  }

  const headAfterBlockRun = getHeadSha(repoPath);
  const followUpResult = runBlockFollowUp(blockId, runsDir, '--report-only');
  const followUpOutput = `${followUpResult.stdout}\n${followUpResult.stderr}`;
  const headAfterFollowUp = getHeadSha(repoPath);

  const manualCount = getManualTaskCount(blockState);
  const repoUnchanged = headAfterFollowUp === headAfterBlockRun && isWorkingTreeClean(repoPath);

  const pass =
    followUpResult.status === 0 &&
    manualCount === 2 &&
    followUpOutput.includes('Tasks needing human follow-up: 0') &&
    followUpOutput.includes('No repository mutation was performed') &&
    repoUnchanged;

  return {
    name: 'B. Multiple blocked tasks report-only',
    pass,
    output: pass ? followUpOutput : `${runOutput}\n${task3Output}\n${followUpOutput}`,
    manualTaskCount: manualCount,
    followUpFilesCreated: 0,
    repoUnchanged,
    redactionPassed: 'n/a',
  };
}

function runScenarioC(scenarioDir, blockId) {
  const branch = `ai/${blockId}`;
  const { repoPath, runsDir } = setupRepo(scenarioDir, branch);
  const blockPath = join(scenarioDir, 'block.json');
  writeBlockFile(blockPath, {
    blockId,
    repoPath,
    branch,
    tasks: [
      { taskId: 'task_1', title: 'Accepted task 1', goal: 'Update README.', allowedFiles: ['README.md'] },
      { taskId: 'task_2', title: 'Accepted task 2', goal: 'Update feature.', allowedFiles: ['feature.txt'] },
    ],
  });

  const env = {
    ...baseEnv({ blockPath, runsDir }),
    REAL_BLOCK_TASK_KIMI_FAKE_RESPONSES: JSON.stringify([
      buildFakeKimiOutput([{ path: 'README.md', content: '# hello\nupdated\n' }]),
      buildFakeKimiOutput([{ path: 'feature.txt', content: 'feature\nupdated\n' }]),
    ]),
    REAL_BLOCK_TASK_REVIEWER_FAKE_RESPONSES: JSON.stringify([
      buildFakeReviewerResponse({ decision: 'accept', nextAction: 'continue', reviewSummary: 'Task 1 accepted' }),
      buildFakeReviewerResponse({ decision: 'accept', nextAction: 'continue', reviewSummary: 'Task 2 accepted' }),
    ]),
  };

  const runResult = runBlock(blockPath, env);
  const runOutput = `${runResult.stdout}\n${runResult.stderr}`;
  if (runResult.status !== 0) {
    return { name: 'C. No blocked tasks', pass: false, output: runOutput, manualTaskCount: 0, followUpFilesCreated: 0, repoUnchanged: false, redactionPassed: 'n/a' };
  }

  const headAfterBlockRun = getHeadSha(repoPath);
  const followUpResult = runBlockFollowUp(blockId, runsDir, '--report-only');
  const followUpOutput = `${followUpResult.stdout}\n${followUpResult.stderr}`;
  const headAfterFollowUp = getHeadSha(repoPath);
  const blockState = loadBlockState(runsDir, blockId);
  const manualCount = getManualTaskCount(blockState);
  const repoUnchanged = headAfterFollowUp === headAfterBlockRun && isWorkingTreeClean(repoPath);

  const pass =
    followUpResult.status === 0 &&
    manualCount === 0 &&
    followUpOutput.includes('No tasks require post-push human follow-up') &&
    repoUnchanged;

  return {
    name: 'C. No blocked tasks',
    pass,
    output: pass ? followUpOutput : `${runOutput}\n${followUpOutput}`,
    manualTaskCount: manualCount,
    followUpFilesCreated: 0,
    repoUnchanged,
    redactionPassed: 'n/a',
  };
}

function runScenarioD(scenarioDir, blockId) {
  const branch = `ai/${blockId}`;
  const { repoPath, runsDir } = setupRepo(scenarioDir, branch);
  const blockPath = join(scenarioDir, 'block.json');
  writeBlockFile(blockPath, {
    blockId,
    repoPath,
    branch,
    tasks: [
      { taskId: 'task_1', title: 'Accepted task', goal: 'Update README.', allowedFiles: ['README.md'] },
      { taskId: 'task_2', title: 'Manual follow-up task', goal: 'Update feature.', allowedFiles: ['feature.txt'] },
    ],
  });

  const env = {
    ...baseEnv({ blockPath, runsDir }),
    REAL_BLOCK_TASK_KIMI_FAKE_RESPONSES: JSON.stringify([
      buildFakeKimiOutput([{ path: 'README.md', content: '# hello\nupdated\n' }]),
      buildFakeKimiOutput([{ path: 'feature.txt', content: 'feature\nupdated\n' }]),
    ]),
    REAL_BLOCK_TASK_REVIEWER_FAKE_RESPONSES: JSON.stringify([
      buildFakeReviewerResponse({ decision: 'accept', nextAction: 'continue', reviewSummary: 'Task 1 accepted' }),
      buildFakeReviewerResponse({
        decision: 'block_for_human',
        nextAction: 'block',
        reviewSummary: 'Task 2 needs human review',
        blockingIssues: ['needs human review'],
      }),
    ]),
  };

  const runResult = runBlock(blockPath, env);
  const runOutput = `${runResult.stdout}\n${runResult.stderr}`;
  if (runResult.status === 0) {
    return { name: 'D. Create follow-ups creates nothing', pass: false, output: runOutput, manualTaskCount: 0, followUpFilesCreated: 0, repoUnchanged: false, redactionPassed: 'n/a' };
  }

  const headAfterBlockRun = getHeadSha(repoPath);
  const followUpResult = runBlockFollowUp(blockId, runsDir, '--create-follow-ups');
  const followUpOutput = `${followUpResult.stdout}\n${followUpResult.stderr}`;
  const headAfterFollowUp = getHeadSha(repoPath);
  const repoUnchanged = headAfterFollowUp === headAfterBlockRun && isWorkingTreeClean(repoPath);

  // With no post-push preserved commits, creation must be vacuously safe:
  // exit 0, zero follow-up files written, repository untouched.
  const filesCreated = countFollowUpFiles(runsDir);

  const pass =
    followUpResult.status === 0 &&
    filesCreated === 0 &&
    followUpOutput.includes('No repository mutation was performed') &&
    repoUnchanged;

  return {
    name: 'D. Create follow-ups creates nothing',
    pass,
    output: pass ? followUpOutput : `${runOutput}\n${followUpOutput}`,
    manualTaskCount: 1,
    followUpFilesCreated: filesCreated,
    repoUnchanged,
    redactionPassed: 'n/a',
  };
}

function runScenarioE(scenarioDir, blockId) {
  const branch = `ai/${blockId}`;
  const { repoPath, runsDir } = setupRepo(scenarioDir, branch);
  const blockPath = join(scenarioDir, 'block.json');
  writeBlockFile(blockPath, {
    blockId,
    repoPath,
    branch,
    tasks: [
      { taskId: 'task_1', title: 'Accepted task', goal: 'Update README.', allowedFiles: ['README.md'] },
      { taskId: 'task_2', title: 'Manual follow-up task', goal: 'Update feature.', allowedFiles: ['feature.txt'] },
    ],
  });

  const env = {
    ...baseEnv({ blockPath, runsDir }),
    REAL_BLOCK_TASK_KIMI_FAKE_RESPONSES: JSON.stringify([
      buildFakeKimiOutput([{ path: 'README.md', content: '# hello\nupdated\n' }]),
      buildFakeKimiOutput([{ path: 'feature.txt', content: 'feature\nupdated\n' }]),
    ]),
    REAL_BLOCK_TASK_REVIEWER_FAKE_RESPONSES: JSON.stringify([
      buildFakeReviewerResponse({ decision: 'accept', nextAction: 'continue', reviewSummary: 'Task 1 accepted' }),
      buildFakeReviewerResponse({
        decision: 'block_for_human',
        nextAction: 'block',
        reviewSummary: 'Task 2 blocked with secrets',
        blockingIssues: [`api_key=${SECRET_API_KEY}`, `token=${SECRET_TOKEN}`, 'needs human review'],
      }),
    ]),
  };

  const runResult = runBlock(blockPath, env);
  const runOutput = `${runResult.stdout}\n${runResult.stderr}`;
  if (runResult.status === 0) {
    return { name: 'E. Redaction proof', pass: false, output: runOutput, manualTaskCount: 0, followUpFilesCreated: 0, repoUnchanged: false, redactionPassed: 'no' };
  }

  const headAfterBlockRun = getHeadSha(repoPath);
  const reportResult = runBlockFollowUp(blockId, runsDir, '--report-only');
  const reportOutput = `${reportResult.stdout}\n${reportResult.stderr}`;
  const createResult = runBlockFollowUp(blockId, runsDir, '--create-follow-ups');
  const createOutput = `${createResult.stdout}\n${createResult.stderr}`;
  const headAfterFollowUp = getHeadSha(repoPath);
  const repoUnchanged = headAfterFollowUp === headAfterBlockRun && isWorkingTreeClean(repoPath);

  // No follow-up file may exist; all outputs, the persisted block state and
  // the persisted child state must be free of the secret strings, and the
  // child state must carry explicit redaction markers.
  const filesCreated = countFollowUpFiles(runsDir);
  const blockStateRaw = readFileSync(join(runsDir, 'block', blockId, 'state.json'), 'utf8');
  const childStatePath = join(runsDir, 'tasks', 'task_2', 'state.json');
  const childStateRaw = existsSync(childStatePath) ? readFileSync(childStatePath, 'utf8') : '';

  const combinedOutput = `${runOutput}\n${reportOutput}\n${createOutput}`;
  const pass =
    reportResult.status === 0 &&
    createResult.status === 0 &&
    filesCreated === 0 &&
    !combinedOutput.includes(SECRET_API_KEY) &&
    !combinedOutput.includes(SECRET_TOKEN) &&
    !blockStateRaw.includes(SECRET_API_KEY) &&
    !blockStateRaw.includes(SECRET_TOKEN) &&
    !childStateRaw.includes(SECRET_API_KEY) &&
    !childStateRaw.includes(SECRET_TOKEN) &&
    childStateRaw.includes('[REDACTED]') &&
    repoUnchanged;

  return {
    name: 'E. Redaction proof',
    pass,
    output: combinedOutput,
    manualTaskCount: 1,
    followUpFilesCreated: filesCreated,
    repoUnchanged,
    redactionPassed: pass ? 'yes' : 'no',
  };
}

function runScenarioF(scenarioDir, blockId) {
  const branch = `ai/${blockId}`;
  const { repoPath, runsDir } = setupRepo(scenarioDir, branch);
  const blockPath = join(scenarioDir, 'block.json');
  writeBlockFile(blockPath, {
    blockId,
    repoPath,
    branch,
    tasks: [
      { taskId: 'task_1', title: 'Accepted task', goal: 'Update README.', allowedFiles: ['README.md'] },
      { taskId: 'task_2', title: 'Manual follow-up task', goal: 'Update feature.', allowedFiles: ['feature.txt'] },
    ],
  });

  const env = {
    ...baseEnv({ blockPath, runsDir }),
    REAL_BLOCK_TASK_KIMI_FAKE_RESPONSES: JSON.stringify([
      buildFakeKimiOutput([{ path: 'README.md', content: '# hello\nupdated\n' }]),
      buildFakeKimiOutput([{ path: 'feature.txt', content: 'feature\nupdated\n' }]),
    ]),
    REAL_BLOCK_TASK_REVIEWER_FAKE_RESPONSES: JSON.stringify([
      buildFakeReviewerResponse({ decision: 'accept', nextAction: 'continue', reviewSummary: 'Task 1 accepted' }),
      buildFakeReviewerResponse({
        decision: 'block_for_human',
        nextAction: 'block',
        reviewSummary: 'Task 2 needs human review',
        blockingIssues: ['needs human review'],
      }),
    ]),
  };

  const runResult = runBlock(blockPath, env);
  const runOutput = `${runResult.stdout}\n${runResult.stderr}`;
  if (runResult.status === 0) {
    return { name: 'F. Corrupted block state refused', pass: false, output: runOutput, manualTaskCount: 0, followUpFilesCreated: 0, repoUnchanged: false, redactionPassed: 'n/a' };
  }

  const headAfterBlockRun = getHeadSha(repoPath);

  // Corrupt the BLOCK state itself; the follow-up command must refuse to use
  // an inconsistent block state instead of silently reporting nothing.
  const blockState = loadBlockState(runsDir, blockId);
  blockState.block_id = 'corrupted-block-id';
  saveBlockState(runsDir, blockId, blockState);

  const followUpResult = runBlockFollowUp(blockId, runsDir, '--report-only');
  const followUpOutput = `${followUpResult.stdout}\n${followUpResult.stderr}`;
  const headAfterFollowUp = getHeadSha(repoPath);
  const repoUnchanged = headAfterFollowUp === headAfterBlockRun && isWorkingTreeClean(repoPath);

  const pass =
    followUpResult.status !== 0 &&
    followUpOutput.includes('Block id mismatch') &&
    followUpOutput.includes('No provider call was made') &&
    followUpOutput.includes('No repository mutation was performed') &&
    repoUnchanged;

  return {
    name: 'F. Corrupted block state refused',
    pass,
    output: followUpOutput,
    manualTaskCount: 1,
    followUpFilesCreated: 0,
    repoUnchanged,
    redactionPassed: 'n/a',
  };
}

function printTable(results) {
  const header = [
    'Scenario'.padEnd(44),
    'Blocked'.padEnd(8),
    'Files'.padEnd(8),
    'Repo OK'.padEnd(8),
    'Redact'.padEnd(8),
    'Pass/Fail'.padEnd(10),
  ].join(' | ');
  console.log(header);
  console.log('-'.repeat(header.length));
  for (const r of results) {
    const line = [
      r.name.padEnd(44),
      String(r.manualTaskCount ?? 'n/a').padEnd(8),
      String(r.followUpFilesCreated ?? 'n/a').padEnd(8),
      String(r.repoUnchanged ? 'yes' : 'no').padEnd(8),
      String(r.redactionPassed ?? 'n/a').padEnd(8),
      (r.pass ? 'PASS' : 'FAIL').padEnd(10),
    ].join(' | ');
    console.log(line);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const baseDir = args.workspace || tmpdir();
  if (!isAbsolute(baseDir)) {
    console.error(`Drill workspace must be an absolute path, got: ${baseDir}`);
    process.exitCode = 1;
    return;
  }
  if (isPathInsideOrEqual(baseDir, PROJECT_ROOT)) {
    console.error(`Drill refuses to use a workspace inside the project repository: ${baseDir}`);
    process.exitCode = 1;
    return;
  }

  const workspace = createWorkspace(baseDir);
  const keepTemp = process.env.BLOCK_FOLLOW_UP_DRILL_KEEP_TEMP === '1';

  if (args.listScenarios) {
    console.log('Scenarios: A B C D E F');
    if (!keepTemp) rmSync(workspace, { recursive: true, force: true });
    return;
  }

  console.log(`Block follow-up drill workspace: ${workspace}`);
  console.log('Using local bare remotes only. No live provider calls.');
  console.log('Blocked tasks are recorded pre-push; follow-up commands must stay');
  console.log('read-only and fail closed on corrupted state.');
  console.log('');

  const scenarios = [
    { run: () => runScenarioA(createScenarioWorkspace(workspace, 'A'), 'block-drill-a'), key: 'A' },
    { run: () => runScenarioB(createScenarioWorkspace(workspace, 'B'), 'block-drill-b'), key: 'B' },
    { run: () => runScenarioC(createScenarioWorkspace(workspace, 'C'), 'block-drill-c'), key: 'C' },
    { run: () => runScenarioD(createScenarioWorkspace(workspace, 'D'), 'block-drill-d'), key: 'D' },
    { run: () => runScenarioE(createScenarioWorkspace(workspace, 'E'), 'block-drill-e'), key: 'E' },
    { run: () => runScenarioF(createScenarioWorkspace(workspace, 'F'), 'block-drill-f'), key: 'F' },
  ];

  const forceFail = process.env.BLOCK_FOLLOW_UP_DRILL_FORCE_FAIL || '';

  const results = [];
  let anyFailed = false;
  for (const { run, key } of scenarios) {
    let result;
    try {
      result = run();
    } catch (err) {
      result = {
        name: 'unknown',
        manualTaskCount: 0,
        followUpFilesCreated: 0,
        repoUnchanged: false,
        redactionPassed: 'unknown',
        pass: false,
        output: err instanceof Error ? err.message : String(err),
      };
    }
    if (forceFail && result.name.startsWith(`${forceFail}.`)) {
      result.pass = false;
      result.forcedFail = true;
    }
    if (!result.pass) anyFailed = true;
    results.push(result);
  }

  printTable(results);
  console.log('');

  for (const r of results) {
    if (!r.pass) {
      console.error(`FAILED scenario output (${r.name}):`);
      console.error(redactOutput(r.output));
      console.error('');
    }
  }

  if (!keepTemp) {
    rmSync(workspace, { recursive: true, force: true });
    console.log('Temp workspace cleaned.');
  } else {
    console.log(`Temp workspace preserved: ${workspace}`);
  }

  if (anyFailed) {
    console.error('DRILL FAILED: one or more scenarios did not pass.');
    process.exitCode = 1;
  } else {
    console.log('DRILL PASSED: all scenarios passed.');
  }
}

main().catch((err) => {
  console.error(redactOutput(err instanceof Error ? err.message : String(err)));
  process.exitCode = 1;
});

#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = resolve(__dirname, '..');
const CLI_PATH = join(PROJECT_ROOT, 'src', 'cli.ts');
const TSX_CLI = join(PROJECT_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const RUNNER_BIN = process.execPath;

const FAKE_API_KEY = 'sk-block-follow-up-drill-fake-key-1234567890';
const FAKE_BASE_URL = 'http://localhost:9999';

const SECRET_API_KEY = 'api_key=secret-block-follow-up-key';
const SECRET_TOKEN = 'token=secret-block-follow-up-token';

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
    .replace(/ghp_[a-zA-Z0-9]{36}/g, 'ghp-***')
    .replace(/github_pat_[a-zA-Z0-9_]{22,}/g, 'github_pat-***')
    .replace(/Bearer\s+[a-zA-Z0-9_\-]{8,}/g, 'Bearer ***')
    .replace(/([a-zA-Z_]*(?:api[_-]?key|token|password|secret))\s*[:=]\s*([^\s\r\n'"]+)/gi, (_match, key, value) => {
      if (value === '[REDACTED]') return `${key}=[REDACTED]`;
      return `${key}=***`;
    });
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
    [TSX_CLI, CLI_PATH, ...args],
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
    'OPENAI_API_KEY', 'MOCK_AI', 'ALLOW_REAL_PROVIDER_RUN', 'ALLOW_REAL_PROVIDER',
    'ALLOW_SANDBOX_APPLY_PREVIEW', 'ALLOW_REAL_REPO_APPLY', 'ALLOW_REAL_REPO_COMMIT', 'ALLOW_REAL_REPO_PUSH',
    'SANDBOX_PROVIDER_RESPONSE', 'SANDBOX_ROOT', 'REAL_REPO_PROVIDER_RESPONSE', 'RUNS_DIR',
    'REAL_REPO_AI_MAX_ATTEMPTS', 'REAL_REPO_REVIEWER_FAKE_RESPONSE', 'KIMI_FAKE_REVIEWER_RESPONSE',
    'REAL_REPO_REVIEWER_NO_DEFAULT', 'REAL_REPO_REVIEWER_CAPTURE_INPUT_FILE', 'REAL_REPO_REVIEWER_FORCE_PROVIDER_ERROR',
    'REAL_REPO_REVIEWER_FIX_TASK_FAKE_EXECUTOR_RESPONSE', 'REAL_REPO_ENABLE_REVIEWER_FIX_LOOP',
    'REAL_REPO_REVIEWER_MAX_FIX_ATTEMPTS', 'REAL_REPO_REVIEWER_SECOND_FAKE_RESPONSE',
    'REAL_REPO_REVIEWER_SECOND_KIMI_FAKE_RESPONSE', 'REAL_REPO_REVIEWER_SECOND_FORCE_PROVIDER_ERROR',
    'REAL_REPO_REVIEWER_FIX_TASK_KIMI_FAKE_RESPONSE', 'REAL_REPO_REVIEWER_FIX_TASK_KIMI_FAKE_RESPONSES',
    'REAL_BLOCK_TASK_KIMI_FAKE_RESPONSES', 'REAL_BLOCK_TASK_REVIEWER_FAKE_RESPONSES',
    'REAL_BLOCK_TASK_FIX_KIMI_FAKE_RESPONSES', 'REAL_BLOCK_TASK_SECOND_REVIEWER_FAKE_RESPONSES',
    'ALLOW_REAL_BLOCK_RUN_AI', 'REAL_BLOCK_RUN_RESUME', 'REAL_BLOCK_RUN_PAUSE_AFTER_TASK_ID',
    'TASKS_FILE',
  ];
  for (const key of keysToDelete) delete env[key];
  env.AI_PROVIDER = 'mock';
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
  writeFileSync(join(repoPath, 'feature.txt'), 'feature\n', 'utf8');
  writeFileSync(join(repoPath, 'feature2.txt'), 'feature2\n', 'utf8');
  runGit(repoPath, ['add', '.']);
  runGit(repoPath, ['commit', '-m', 'init', '--no-gpg-sign']);
  runGit(repoPath, ['branch', '-m', 'main']);
  runGit(repoPath, ['checkout', '-b', branch]);

  runGit(originPath, ['init', '--bare']);
  runGit(repoPath, ['remote', 'add', 'origin', originPath]);

  return { repoPath, originPath, runsDir, branch };
}

function writeBlockFile(blockPath, { blockId, repoPath, branch, tasks }) {
  const block = {
    block_id: blockId,
    title: `Block follow-up drill ${blockId}`,
    repo_path: resolve(repoPath).replace(/\\/g, '/'),
    base_branch: 'main',
    work_branch: branch,
    providers: {
      coder: { provider: 'kimi', model: 'kimi-k2.6' },
      reviewer: { provider: 'kimi', model: 'kimi-k2.6' },
    },
    review_policy: {
      require_deterministic_checks: false,
      max_fix_attempts: 1,
      reviewer_mode: 'single',
    },
    tasks: tasks.map((t) => ({
      task_id: t.taskId,
      title: t.title,
      goal: t.goal,
      allowed_files: t.allowedFiles,
      denied_files: t.deniedFiles ?? [],
      max_lines_changed: t.maxLinesChanged ?? 150,
      checks: t.checks ?? [],
    })),
  };
  writeFileSync(blockPath, JSON.stringify(block, null, 2), 'utf8');
}

function baseEnv({ blockPath, runsDir }) {
  return {
    RUNS_DIR: runsDir,
    ALLOW_REAL_BLOCK_RUN_AI: 'true',
    ALLOW_REAL_PROVIDER: 'true',
    ALLOW_REAL_REPO_APPLY: 'true',
    ALLOW_REAL_REPO_COMMIT: 'true',
    ALLOW_REAL_REPO_PUSH: 'true',
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

function loadChildState(runsDir, taskId) {
  const statePath = join(runsDir, taskId, 'state.json');
  if (!existsSync(statePath)) return null;
  return JSON.parse(readFileSync(statePath, 'utf8'));
}

function saveChildState(runsDir, taskId, state) {
  const statePath = join(runsDir, taskId, 'state.json');
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
    RUNS_DIR: runsDir,
    ALLOW_REAL_PROVIDER: 'true',
    ALLOW_REAL_REPO_APPLY: 'true',
    ALLOW_REAL_REPO_COMMIT: 'true',
    ALLOW_REAL_REPO_PUSH: 'true',
    REAL_REPO_ENABLE_REVIEWER_FIX_LOOP: '0',
    REAL_REPO_AI_MAX_ATTEMPTS: '1',
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

function deriveManualTaskResult(childState, taskId, title) {
  const rollback = childState.rollback ?? {};
  const reviewerGate = childState.reviewer_gate ?? {};
  return {
    taskId,
    title,
    status: 'blocked',
    originalCommitSha: childState.commit_sha,
    fixAttempted: false,
    finalStatus: 'blocked',
    nextAction: 'block',
    childStateTaskId: taskId,
    rollbackPolicy: rollback.policy,
    rollbackReason: typeof rollback.reason === 'string' ? rollback.reason : 'Post-push preserve for human.',
    reviewerGateStatus: reviewerGate.status,
    reviewerSummary: reviewerGate.reviewSummary,
  };
}

function appendManualTaskToBlockState(runsDir, blockId, taskId, title) {
  const childState = loadChildState(runsDir, taskId);
  if (!childState) throw new Error(`Child state for ${taskId} not found`);
  const blockState = loadBlockState(runsDir, blockId);
  if (!blockState) throw new Error(`Block state for ${blockId} not found`);
  const existingIndex = blockState.taskResults.findIndex((r) => r.taskId === taskId);
  const result = deriveManualTaskResult(childState, taskId, title);
  if (existingIndex >= 0) {
    blockState.taskResults[existingIndex] = result;
  } else {
    blockState.taskResults.push(result);
    blockState.summary.totalTasks = blockState.taskResults.length;
  }
  saveBlockState(runsDir, blockId, blockState);
}

function getManualTaskCount(blockState) {
  if (!blockState || !Array.isArray(blockState.taskResults)) return 0;
  return blockState.taskResults.filter(
    (r) => r.rollbackPolicy === 'post_push_preserve_for_human'
  ).length;
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
    return { name: 'A. One manual task report-only', pass: false, output: runOutput };
  }

  const headAfterBlockRun = getHeadSha(repoPath);
  const blockState = loadBlockState(runsDir, blockId);
  const followUpResult = runBlockFollowUp(blockId, runsDir, '--report-only');
  const followUpOutput = `${followUpResult.stdout}\n${followUpResult.stderr}`;
  const headAfterFollowUp = getHeadSha(repoPath);

  const manualCount = getManualTaskCount(blockState);
  const repoUnchanged = headAfterFollowUp === headAfterBlockRun && isWorkingTreeClean(repoPath);
  const task2Result = blockState?.taskResults?.find((r) => r.taskId === 'task_2');

  const pass =
    followUpResult.status === 0 &&
    manualCount === 1 &&
    followUpOutput.includes('Tasks needing human follow-up: 1') &&
    followUpOutput.includes('task_2') &&
    followUpOutput.includes(task2Result?.originalCommitSha ?? '') &&
    followUpOutput.includes('post_push_preserve_for_human') &&
    followUpOutput.includes('real-repo-follow-up task_2 --report-only') &&
    !followUpOutput.includes('Task: task_1') &&
    followUpOutput.includes('No repository mutation was performed') &&
    repoUnchanged;

  return {
    name: 'A. One manual task report-only',
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
  const { repoPath, originPath, runsDir } = setupRepo(scenarioDir, branch);
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
    return { name: 'B. Multiple manual tasks report-only', pass: false, output: runOutput };
  }

  // The block runner stops after the first non-accepted task, so task_3 was not run.
  // Run task_3 separately using the same repo/branch and append its real child state
  // to the block state to prove follow-up recovery for multiple manual tasks.
  const tasksFilePath = join(scenarioDir, 'task_3.tasks.yaml');
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
    return { name: 'B. Multiple manual tasks report-only', pass: false, output: task3Output };
  }

  try {
    appendManualTaskToBlockState(runsDir, blockId, 'task_3', 'Manual task B');
  } catch (err) {
    return { name: 'B. Multiple manual tasks report-only', pass: false, output: err instanceof Error ? err.message : String(err) };
  }

  const headAfterBlockRun = getHeadSha(repoPath);

  const blockState = loadBlockState(runsDir, blockId);
  const followUpResult = runBlockFollowUp(blockId, runsDir, '--report-only');
  const followUpOutput = `${followUpResult.stdout}\n${followUpResult.stderr}`;
  const headAfterFollowUp = getHeadSha(repoPath);

  const manualCount = getManualTaskCount(blockState);
  const repoUnchanged = headAfterFollowUp === headAfterBlockRun && isWorkingTreeClean(repoPath);
  const task2Result = blockState?.taskResults?.find((r) => r.taskId === 'task_2');
  const task3Result = blockState?.taskResults?.find((r) => r.taskId === 'task_3');

  const pass =
    followUpResult.status === 0 &&
    manualCount === 2 &&
    followUpOutput.includes('Tasks needing human follow-up: 2') &&
    followUpOutput.includes('task_2') &&
    followUpOutput.includes('task_3') &&
    followUpOutput.includes(task2Result?.originalCommitSha ?? '') &&
    followUpOutput.includes(task3Result?.originalCommitSha ?? '') &&
    followUpOutput.includes('real-repo-follow-up task_2 --report-only') &&
    followUpOutput.includes('real-repo-follow-up task_3 --report-only') &&
    repoUnchanged;

  return {
    name: 'B. Multiple manual tasks report-only',
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
    return { name: 'C. No manual follow-up tasks', pass: false, output: runOutput };
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
    name: 'C. No manual follow-up tasks',
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
    return { name: 'D. Create follow-ups for manual task', pass: false, output: runOutput };
  }

  const headAfterBlockRun = getHeadSha(repoPath);
  const followUpResult = runBlockFollowUp(blockId, runsDir, '--create-follow-ups');
  const followUpOutput = `${followUpResult.stdout}\n${followUpResult.stderr}`;
  const headAfterFollowUp = getHeadSha(repoPath);
  const repoUnchanged = headAfterFollowUp === headAfterBlockRun && isWorkingTreeClean(repoPath);

  const followUpFilePath = join(runsDir, 'task_2', 'follow-up-task_2-follow-up.yaml');
  const fileExists = existsSync(followUpFilePath);
  let fileValid = false;
  if (fileExists) {
    const content = readFileSync(followUpFilePath, 'utf8');
    fileValid =
      content.includes('id: task_2-follow-up') &&
      content.includes('auto_commit: false') &&
      content.includes('auto_push: false') &&
      content.includes('auto_merge: false');
  }

  const pass =
    followUpResult.status === 0 &&
    fileExists &&
    fileValid &&
    followUpOutput.includes('Follow-up task file:') &&
    repoUnchanged;

  return {
    name: 'D. Create follow-ups for manual task',
    pass,
    output: pass ? followUpOutput : `${runOutput}\n${followUpOutput}`,
    manualTaskCount: 1,
    followUpFilesCreated: fileExists ? 1 : 0,
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
        blockingIssues: [SECRET_API_KEY, SECRET_TOKEN, 'needs human review'],
      }),
    ]),
  };

  const runResult = runBlock(blockPath, env);
  const runOutput = `${runResult.stdout}\n${runResult.stderr}`;
  if (runResult.status === 0) {
    return { name: 'E. Redaction proof', pass: false, output: runOutput };
  }

  const headAfterBlockRun = getHeadSha(repoPath);
  const reportResult = runBlockFollowUp(blockId, runsDir, '--report-only');
  const reportOutput = `${reportResult.stdout}\n${reportResult.stderr}`;
  const createResult = runBlockFollowUp(blockId, runsDir, '--create-follow-ups');
  const createOutput = `${createResult.stdout}\n${createResult.stderr}`;
  const headAfterFollowUp = getHeadSha(repoPath);
  const repoUnchanged = headAfterFollowUp === headAfterBlockRun && isWorkingTreeClean(repoPath);

  const followUpFilePath = join(runsDir, 'task_2', 'follow-up-task_2-follow-up.yaml');
  let fileRedacted = false;
  if (existsSync(followUpFilePath)) {
    const content = readFileSync(followUpFilePath, 'utf8');
    fileRedacted =
      !content.includes('secret-block-follow-up-key') &&
      !content.includes('secret-block-follow-up-token') &&
      content.includes('[REDACTED]');
  }

  const combinedOutput = `${reportOutput}\n${createOutput}`;
  const pass =
    reportResult.status === 0 &&
    createResult.status === 0 &&
    !combinedOutput.includes('secret-block-follow-up-key') &&
    !combinedOutput.includes('secret-block-follow-up-token') &&
    combinedOutput.includes('[REDACTED]') &&
    fileRedacted &&
    repoUnchanged;

  return {
    name: 'E. Redaction proof',
    pass,
    output: combinedOutput,
    manualTaskCount: 1,
    followUpFilesCreated: existsSync(followUpFilePath) ? 1 : 0,
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
    return { name: 'F. Corrupted child state refused', pass: false, output: runOutput };
  }

  const headAfterBlockRun = getHeadSha(repoPath);
  const childState = loadChildState(runsDir, 'task_2');
  if (childState) {
    childState.task_id = 'corrupted-task-id';
    saveChildState(runsDir, 'task_2', childState);
  }

  const followUpResult = runBlockFollowUp(blockId, runsDir, '--report-only');
  const followUpOutput = `${followUpResult.stdout}\n${followUpResult.stderr}`;
  const headAfterFollowUp = getHeadSha(repoPath);
  const repoUnchanged = headAfterFollowUp === headAfterBlockRun && isWorkingTreeClean(repoPath);

  const pass =
    followUpResult.status !== 0 &&
    (followUpOutput.includes('task_id mismatch') || followUpOutput.includes('mismatch')) &&
    followUpOutput.includes('No provider call was made') &&
    followUpOutput.includes('No repository mutation was performed') &&
    repoUnchanged;

  return {
    name: 'F. Corrupted child state refused',
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
    'Scenario'.padEnd(52),
    'Manual'.padEnd(8),
    'Files'.padEnd(8),
    'Repo OK'.padEnd(8),
    'Redact'.padEnd(8),
    'Pass/Fail'.padEnd(10),
  ].join(' | ');
  console.log(header);
  console.log('-'.repeat(header.length));
  for (const r of results) {
    const line = [
      r.name.padEnd(52),
      String(r.manualTaskCount ?? 'n/a').padEnd(8),
      String(r.followUpFilesCreated ?? 'n/a').padEnd(8),
      (r.repoUnchanged ? 'yes' : 'no').padEnd(8),
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
        name: `${key}. unknown`,
        pass: false,
        output: err instanceof Error ? err.message : String(err),
        manualTaskCount: 'n/a',
        followUpFilesCreated: 'n/a',
        repoUnchanged: false,
        redactionPassed: 'n/a',
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

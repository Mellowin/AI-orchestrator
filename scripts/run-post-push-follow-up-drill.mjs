#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = resolve(__dirname, '..');
const CLI_PATH = join(PROJECT_ROOT, 'src', 'cli.ts');
const TSX_CLI = join(PROJECT_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const RUNNER_BIN = process.execPath;

const FAKE_API_KEY = 'sk-follow-up-drill-fake-key-1234567890';
const FAKE_BASE_URL = 'http://localhost:9999';

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
  return mkdtempSync(join(baseDir, 'follow-up-drill-'));
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

function setupRepo(scenarioDir, taskId) {
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
  const branch = `ai/${taskId}`;
  runGit(repoPath, ['checkout', '-b', branch]);

  runGit(originPath, ['init', '--bare']);
  runGit(repoPath, ['remote', 'add', 'origin', originPath]);

  return { repoPath, originPath, runsDir, branch };
}

function writeTasksFile(tasksFilePath, { taskId, repoPath, branch }) {
  const content = `tasks:
  - id: ${taskId}
    title: "Follow-up drill ${taskId}"
    repo_path: "${repoPath.replace(/\\/g, '/')}"
    base_branch: "main"
    work_branch: "${branch}"
    goal: "Drill post-push follow-up recovery"
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
`;
  writeFileSync(tasksFilePath, content, 'utf8');
}

function baseEnv({ tasksFilePath, runsDir }) {
  return {
    TASKS_FILE: tasksFilePath,
    RUNS_DIR: runsDir,
    ALLOW_REAL_PROVIDER: 'true',
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

function loadState(runsDir, taskId) {
  const statePath = join(runsDir, taskId, 'state.json');
  if (!existsSync(statePath)) return null;
  return JSON.parse(readFileSync(statePath, 'utf8'));
}

function saveState(runsDir, taskId, state) {
  const statePath = join(runsDir, taskId, 'state.json');
  writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf8');
}

function runPostPushBlockScenario(scenarioDir, taskId) {
  const { repoPath, runsDir, branch } = setupRepo(scenarioDir, taskId);
  const tasksFilePath = join(scenarioDir, 'tasks.yaml');
  writeTasksFile(tasksFilePath, { taskId, repoPath, branch });

  const beforeHead = getHeadSha(repoPath);

  const runResult = runCli(['real-repo-run-ai', taskId], {
    ...baseEnv({ tasksFilePath, runsDir }),
    KIMI_FAKE_RESPONSE: buildFakeKimiOutput([{ path: 'README.md', content: '# modified\n' }]),
    REAL_REPO_REVIEWER_FAKE_RESPONSE: buildFakeReviewerResponse({
      decision: 'block_for_human',
      nextAction: 'block',
      reviewSummary: 'Human review required',
      blockingIssues: [
        'api_key=secret-follow-up-drill-key',
        'token=secret-follow-up-drill-token',
        'needs human review',
      ],
    }),
  });

  const state = loadState(runsDir, taskId);
  const afterHead = getHeadSha(repoPath);
  const output = `${runResult.stdout}\n${runResult.stderr}`;

  const pass =
    runResult.status !== 0 &&
    state?.rollback?.status === 'skipped' &&
    state?.rollback?.policy === 'post_push_preserve_for_human' &&
    afterHead !== beforeHead &&
    isWorkingTreeClean(repoPath);

  return {
    state,
    repoPath,
    runsDir,
    branch,
    tasksFilePath,
    pass,
    output,
  };
}

function runPostPushRejectFixDisabledScenario(scenarioDir, taskId) {
  const { repoPath, runsDir, branch } = setupRepo(scenarioDir, taskId);
  const tasksFilePath = join(scenarioDir, 'tasks.yaml');
  writeTasksFile(tasksFilePath, { taskId, repoPath, branch });

  const beforeHead = getHeadSha(repoPath);

  const runResult = runCli(['real-repo-run-ai', taskId], {
    ...baseEnv({ tasksFilePath, runsDir }),
    KIMI_FAKE_RESPONSE: buildFakeKimiOutput([{ path: 'README.md', content: '# modified\n' }]),
    REAL_REPO_REVIEWER_FAKE_RESPONSE: buildFakeReviewerResponse({
      decision: 'reject',
      nextAction: 'fix',
      reviewSummary: 'Needs fix',
      blockingIssues: ['needs fix'],
      fixTask: 'Add more detail',
    }),
    REAL_REPO_ENABLE_REVIEWER_FIX_LOOP: '0',
  });

  const state = loadState(runsDir, taskId);
  const afterHead = getHeadSha(repoPath);
  const output = `${runResult.stdout}\n${runResult.stderr}`;

  const pass =
    runResult.status !== 0 &&
    state?.rollback?.status === 'skipped' &&
    state?.rollback?.policy === 'post_push_preserve_for_human' &&
    afterHead !== beforeHead &&
    isWorkingTreeClean(repoPath);

  return {
    state,
    repoPath,
    runsDir,
    branch,
    tasksFilePath,
    pass,
    output,
  };
}

function runPostPushFixThenSecondBlockScenario(scenarioDir, taskId) {
  const { repoPath, runsDir, branch } = setupRepo(scenarioDir, taskId);
  const tasksFilePath = join(scenarioDir, 'tasks.yaml');
  writeTasksFile(tasksFilePath, { taskId, repoPath, branch });

  const beforeHead = getHeadSha(repoPath);

  const runResult = runCli(['real-repo-run-ai', taskId], {
    ...baseEnv({ tasksFilePath, runsDir }),
    KIMI_FAKE_RESPONSE: buildFakeKimiOutput([{ path: 'README.md', content: '# modified\n' }]),
    REAL_REPO_REVIEWER_FAKE_RESPONSE: buildFakeReviewerResponse({
      decision: 'reject',
      nextAction: 'fix',
      reviewSummary: 'Needs fix',
      blockingIssues: ['needs fix'],
      fixTask: 'Add fix detail',
    }),
    REAL_REPO_ENABLE_REVIEWER_FIX_LOOP: '1',
    REAL_REPO_REVIEWER_FIX_TASK_KIMI_FAKE_RESPONSE: buildFakeKimiOutput([{ path: 'fix.txt', content: 'fix applied\n' }]),
    REAL_REPO_REVIEWER_SECOND_FAKE_RESPONSE: buildFakeReviewerResponse({
      decision: 'block_for_human',
      nextAction: 'block',
      reviewSummary: 'Second reviewer blocked',
      blockingIssues: ['second reviewer requires human review'],
    }),
  });

  const state = loadState(runsDir, taskId);
  const afterHead = getHeadSha(repoPath);
  const output = `${runResult.stdout}\n${runResult.stderr}`;

  const pass =
    runResult.status !== 0 &&
    state?.rollback?.status === 'skipped' &&
    state?.rollback?.policy === 'post_push_preserve_for_human' &&
    afterHead !== beforeHead &&
    !!state?.reviewer_fix_task_second_review?.fixCommitSha &&
    isWorkingTreeClean(repoPath);

  return {
    state,
    repoPath,
    runsDir,
    branch,
    tasksFilePath,
    pass,
    output,
  };
}

function runReportOnlyFollowUp({ runsDir, taskId }) {
  return runCli(['real-repo-follow-up', taskId, '--report-only'], {
    RUNS_DIR: runsDir,
  });
}

function runCreateFollowUp({ runsDir, taskId, newTaskId }) {
  return runCli(['real-repo-follow-up', taskId, '--create-follow-up', newTaskId], {
    RUNS_DIR: runsDir,
  });
}

function runScenarioA(scenarioDir, taskId) {
  const { state, repoPath, runsDir, pass, output } = runPostPushBlockScenario(scenarioDir, taskId);
  if (!pass) {
    return { name: 'A. Post-push block → report-only', pass: false, output };
  }

  const followUpResult = runReportOnlyFollowUp({ runsDir, taskId });
  const followUpOutput = `${followUpResult.stdout}\n${followUpResult.stderr}`;
  const headBefore = getHeadSha(repoPath);
  const reportPass =
    followUpResult.status === 0 &&
    followUpOutput.includes('Preserved original commit') &&
    followUpOutput.includes(state.commit_sha) &&
    followUpOutput.includes('Human follow-up required before merge') &&
    followUpOutput.includes('No provider call was made') &&
    followUpOutput.includes('No repository mutation was performed') &&
    isWorkingTreeClean(repoPath) &&
    getHeadSha(repoPath) === headBefore;

  return {
    name: 'A. Post-push block → report-only',
    pass: reportPass,
    output: followUpOutput,
    stateCreated: true,
    mode: 'report-only',
    expectedPolicy: 'post_push_preserve_for_human',
    actualPolicy: state?.rollback?.policy,
    repoUnchanged: getHeadSha(repoPath) === headBefore && isWorkingTreeClean(repoPath),
  };
}

function runScenarioB(scenarioDir, taskId) {
  const { state, repoPath, runsDir, pass, output } = runPostPushRejectFixDisabledScenario(scenarioDir, taskId);
  if (!pass) {
    return { name: 'B. Post-push reject/fix-disabled → report-only', pass: false, output };
  }

  const followUpResult = runReportOnlyFollowUp({ runsDir, taskId });
  const followUpOutput = `${followUpResult.stdout}\n${followUpResult.stderr}`;
  const headBefore = getHeadSha(repoPath);
  const reportPass =
    followUpResult.status === 0 &&
    followUpOutput.includes('Preserved original commit') &&
    followUpOutput.includes(state.commit_sha) &&
    followUpOutput.includes('Human follow-up required before merge') &&
    isWorkingTreeClean(repoPath) &&
    getHeadSha(repoPath) === headBefore;

  return {
    name: 'B. Post-push reject/fix-disabled → report-only',
    pass: reportPass,
    output: followUpOutput,
    stateCreated: true,
    mode: 'report-only',
    expectedPolicy: 'post_push_preserve_for_human',
    actualPolicy: state?.rollback?.policy,
    repoUnchanged: getHeadSha(repoPath) === headBefore && isWorkingTreeClean(repoPath),
  };
}

function runScenarioC(scenarioDir, taskId) {
  const { state, repoPath, runsDir, pass, output } = runPostPushFixThenSecondBlockScenario(scenarioDir, taskId);
  if (!pass) {
    return { name: 'C. Second reviewer block after pushed fix → report-only', pass: false, output };
  }

  const followUpResult = runReportOnlyFollowUp({ runsDir, taskId });
  const followUpOutput = `${followUpResult.stdout}\n${followUpResult.stderr}`;
  const headBefore = getHeadSha(repoPath);
  const fixCommitSha = state?.reviewer_fix_task_second_review?.fixCommitSha;
  const reportPass =
    followUpResult.status === 0 &&
    followUpOutput.includes('Preserved original commit') &&
    followUpOutput.includes(state.commit_sha) &&
    followUpOutput.includes('Preserved fix commit') &&
    followUpOutput.includes(fixCommitSha) &&
    followUpOutput.includes('Human follow-up required before merge') &&
    isWorkingTreeClean(repoPath) &&
    getHeadSha(repoPath) === headBefore;

  return {
    name: 'C. Second reviewer block after pushed fix → report-only',
    pass: reportPass,
    output: followUpOutput,
    stateCreated: true,
    mode: 'report-only',
    expectedPolicy: 'post_push_preserve_for_human',
    actualPolicy: state?.rollback?.policy,
    repoUnchanged: getHeadSha(repoPath) === headBefore && isWorkingTreeClean(repoPath),
  };
}

function runScenarioD(scenarioDir, taskId, newTaskId) {
  const { state, repoPath, runsDir, pass, output } = runPostPushBlockScenario(scenarioDir, taskId);
  if (!pass) {
    return { name: 'D. Create follow-up task file', pass: false, output };
  }

  const headBefore = getHeadSha(repoPath);
  const followUpResult = runCreateFollowUp({ runsDir, taskId, newTaskId });
  const followUpOutput = `${followUpResult.stdout}\n${followUpResult.stderr}`;
  const followUpFilePath = join(runsDir, taskId, `follow-up-${newTaskId}.yaml`);
  const fileExists = existsSync(followUpFilePath);
  let fileValid = false;
  if (fileExists) {
    const content = readFileSync(followUpFilePath, 'utf8');
    fileValid =
      content.includes(`id: ${newTaskId}`) &&
      content.includes('auto_commit: false') &&
      content.includes('auto_push: false') &&
      content.includes('auto_merge: false') &&
      content.includes('work_branch') &&
      !content.includes('secret-follow-up-drill-key') &&
      !content.includes('secret-follow-up-drill-token');
  }

  const passD =
    followUpResult.status === 0 &&
    fileExists &&
    fileValid &&
    followUpOutput.includes('Follow-up task file:') &&
    followUpOutput.includes('Next command:') &&
    followUpOutput.includes(newTaskId) &&
    isWorkingTreeClean(repoPath) &&
    getHeadSha(repoPath) === headBefore;

  return {
    name: 'D. Create follow-up task file',
    pass: passD,
    output: followUpOutput,
    stateCreated: true,
    mode: 'create-follow-up',
    expectedPolicy: 'post_push_preserve_for_human',
    actualPolicy: state?.rollback?.policy,
    repoUnchanged: getHeadSha(repoPath) === headBefore && isWorkingTreeClean(repoPath),
  };
}

function runScenarioE(scenarioDir, taskId) {
  const { state, repoPath, runsDir, pass, output } = runPostPushBlockScenario(scenarioDir, taskId);
  if (!pass) {
    return { name: 'E. Redaction proof', pass: false, output };
  }

  const followUpResult = runReportOnlyFollowUp({ runsDir, taskId });
  const followUpOutput = `${followUpResult.stdout}\n${followUpResult.stderr}`;
  const newTaskId = `${taskId}-follow-up`;
  const createResult = runCreateFollowUp({ runsDir, taskId, newTaskId });
  const createOutput = `${createResult.stdout}\n${createResult.stderr}`;
  const followUpFilePath = join(runsDir, taskId, `follow-up-${newTaskId}.yaml`);

  let fileRedacted = false;
  if (existsSync(followUpFilePath)) {
    const content = readFileSync(followUpFilePath, 'utf8');
    fileRedacted =
      !content.includes('secret-follow-up-drill-key') &&
      !content.includes('secret-follow-up-drill-token');
  }

  const passE =
    followUpResult.status === 0 &&
    createResult.status === 0 &&
    !followUpOutput.includes('secret-follow-up-drill-key') &&
    !followUpOutput.includes('secret-follow-up-drill-token') &&
    !createOutput.includes('secret-follow-up-drill-key') &&
    !createOutput.includes('secret-follow-up-drill-token') &&
    followUpOutput.includes('[REDACTED]') &&
    fileRedacted;

  return {
    name: 'E. Redaction proof',
    pass: passE,
    output: `${followUpOutput}\n${createOutput}`,
    stateCreated: true,
    mode: 'report+create',
    expectedPolicy: 'post_push_preserve_for_human',
    actualPolicy: state?.rollback?.policy,
    repoUnchanged: isWorkingTreeClean(repoPath),
  };
}

function runScenarioF(scenarioDir, taskId) {
  const { state, repoPath, runsDir, pass, output } = runPostPushBlockScenario(scenarioDir, taskId);
  if (!pass) {
    return { name: 'F. Corrupted state task_id → refused', pass: false, output };
  }

  const statePath = join(runsDir, taskId, 'state.json');
  const corruptedState = loadState(runsDir, taskId);
  corruptedState.task_id = 'corrupted-task-id';
  saveState(runsDir, taskId, corruptedState);

  const headBefore = getHeadSha(repoPath);
  const followUpResult = runReportOnlyFollowUp({ runsDir, taskId });
  const followUpOutput = `${followUpResult.stdout}\n${followUpResult.stderr}`;

  const passF =
    followUpResult.status !== 0 &&
    (followUpOutput.includes('task_id mismatch') || followUpOutput.includes('mismatch')) &&
    followUpOutput.includes('No provider call was made') &&
    followUpOutput.includes('No repository mutation was performed') &&
    isWorkingTreeClean(repoPath) &&
    getHeadSha(repoPath) === headBefore;

  return {
    name: 'F. Corrupted state task_id → refused',
    pass: passF,
    output: followUpOutput,
    stateCreated: true,
    mode: 'report-only',
    expectedPolicy: 'post_push_preserve_for_human',
    actualPolicy: state?.rollback?.policy,
    repoUnchanged: getHeadSha(repoPath) === headBefore && isWorkingTreeClean(repoPath),
  };
}

function printTable(results) {
  const header = [
    'Scenario'.padEnd(62),
    'State'.padEnd(6),
    'Mode'.padEnd(18),
    'Expected policy'.padEnd(28),
    'Actual policy'.padEnd(28),
    'Repo OK'.padEnd(8),
    'Pass/Fail'.padEnd(10),
  ].join(' | ');
  console.log(header);
  console.log('-'.repeat(header.length));
  for (const r of results) {
    const line = [
      r.name.padEnd(62),
      (r.stateCreated ? 'yes' : 'no').padEnd(6),
      r.mode.padEnd(18),
      (r.expectedPolicy || 'n/a').padEnd(28),
      (r.actualPolicy || 'n/a').padEnd(28),
      (r.repoUnchanged ? 'yes' : 'no').padEnd(8),
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
  const keepTemp = process.env.FOLLOW_UP_DRILL_KEEP_TEMP === '1';

  if (args.listScenarios) {
    console.log('Scenarios: A B C D E F');
    if (!keepTemp) rmSync(workspace, { recursive: true, force: true });
    return;
  }

  console.log(`Post-push follow-up drill workspace: ${workspace}`);
  console.log('Using local bare remotes only. No live provider calls.');
  console.log('');

  const scenarios = [
    { run: () => runScenarioA(createScenarioWorkspace(workspace, 'A'), 'drill-a'), key: 'A' },
    { run: () => runScenarioB(createScenarioWorkspace(workspace, 'B'), 'drill-b'), key: 'B' },
    { run: () => runScenarioC(createScenarioWorkspace(workspace, 'C'), 'drill-c'), key: 'C' },
    { run: () => runScenarioD(createScenarioWorkspace(workspace, 'D'), 'drill-d', 'drill-d-follow-up'), key: 'D' },
    { run: () => runScenarioE(createScenarioWorkspace(workspace, 'E'), 'drill-e'), key: 'E' },
    { run: () => runScenarioF(createScenarioWorkspace(workspace, 'F'), 'drill-f'), key: 'F' },
  ];

  const forceFail = process.env.FOLLOW_UP_DRILL_FORCE_FAIL || '';

  const results = [];
  let anyFailed = false;
  for (const { run, key } of scenarios) {
    let result;
    try {
      result = run();
    } catch (err) {
      result = {
        name: `${key}. unknown`,
        stateCreated: false,
        mode: 'unknown',
        expectedPolicy: 'post_push_preserve_for_human',
        actualPolicy: 'unknown',
        repoUnchanged: false,
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

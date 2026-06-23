#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
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

/**
 * Parse CLI args.
 * --workspace path
 * --list-scenarios
 */
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
  reviewSummary = 'Drill reviewer response; token sk-reviewer-secret-1234567890',
  nextAction = 'continue',
  fixTask,
}) {
  return JSON.stringify({ decision, confidence, blockingIssues, nonBlockingIssues, reviewSummary, nextAction, fixTask });
}

function loadState(runsDir, taskId) {
  const statePath = join(runsDir, taskId, 'state.json');
  if (!existsSync(statePath)) return null;
  return JSON.parse(readFileSync(statePath, 'utf8'));
}

function parseRollbackFromOutput(output) {
  const statusMatch = output.match(/Rollback attempted:.*status=(\S+)/);
  const policyMatch = output.match(/Rollback attempted:.*policy=(\S+)/);
  return {
    status: statusMatch ? statusMatch[1] : null,
    policy: policyMatch ? policyMatch[1] : null,
  };
}

function getHeadSha(repoPath) {
  const result = runGit(repoPath, ['rev-parse', '--verify', 'HEAD']);
  if (result.status !== 0) return null;
  return result.stdout.trim();
}

function getRemoteRef(originPath, branch) {
  const refPath = join(originPath, 'refs', 'heads', branch);
  if (!existsSync(refPath)) return null;
  return readFileSync(refPath, 'utf8').trim();
}

function isWorkingTreeClean(repoPath) {
  const result = runGit(repoPath, ['status', '--porcelain']);
  if (result.status !== 0) return false;
  return result.stdout.trim().length === 0;
}

function isPathInsideOrEqual(child, parent) {
  const rChild = resolve(child);
  const rParent = resolve(parent);
  if (rChild === rParent) return true;
  return rChild.toLowerCase().startsWith(rParent.toLowerCase() + '\\') || rChild.startsWith(rParent + '/');
}

function createWorkspace(baseDir) {
  const workspace = mkdtempSync(join(baseDir, 'rollback-drill-'));
  return workspace;
}

function createScenarioWorkspace(workspace, scenarioName) {
  const dir = join(workspace, scenarioName);
  mkdirSync(dir, { recursive: true });
  return dir;
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

function setupBrokenRemoteRepo(scenarioDir, taskId) {
  const repoPath = join(scenarioDir, 'repo');
  const originPath = join(scenarioDir, 'broken-origin');
  const runsDir = join(scenarioDir, 'runs');
  mkdirSync(repoPath, { recursive: true });
  mkdirSync(runsDir, { recursive: true });
  mkdirSync(originPath, { recursive: true });
  writeFileSync(join(originPath, 'not-a-repo.txt'), 'nope', 'utf8');

  runGit(repoPath, ['init']);
  runGit(repoPath, ['config', 'user.email', 'drill@example.com']);
  runGit(repoPath, ['config', 'user.name', 'Drill Bot']);
  writeFileSync(join(repoPath, 'README.md'), '# hello\n', 'utf8');
  runGit(repoPath, ['add', '.']);
  runGit(repoPath, ['commit', '-m', 'init', '--no-gpg-sign']);
  runGit(repoPath, ['branch', '-m', 'main']);
  const branch = `ai/${taskId}`;
  runGit(repoPath, ['checkout', '-b', branch]);

  runGit(repoPath, ['remote', 'add', 'origin', originPath]);

  return { repoPath, originPath, runsDir, branch };
}

function writeTasksFile(tasksFilePath, { taskId, repoPath, branch, checks = [], maxLinesChanged = 150 }) {
  const checkLines = checks.length > 0
    ? checks.map((c) => `    - command: "${c.command}"\n      args: [${c.args.map((a) => `"${a}"`).join(', ')}]`).join('\n')
    : '    - command: "node"\n      args: ["-e", "process.exit(0)"]';

  writeFileSync(
    tasksFilePath,
    `tasks:
  - id: ${taskId}
    title: "Rollback drill ${taskId}"
    repo_path: "${repoPath.replace(/\\/g, '/')}"
    base_branch: "main"
    work_branch: "${branch}"
    goal: "Drill rollback policy"
    context_files: []
    checks:
${checkLines}
    guardrails:
      deny_modify:
        - ".env"
        - ".env.*"
        - "node_modules/**"
      max_lines_changed: ${maxLinesChanged}
      require_tests: false
      auto_commit: false
      auto_push: false
      auto_merge: false
`,
    'utf8'
  );
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

function runScenarioA(scenarioDir, taskId) {
  const { repoPath, originPath, runsDir, branch } = setupRepo(scenarioDir, taskId);
  const tasksFilePath = join(scenarioDir, 'tasks.yaml');
  // This check intentionally passes in the sandbox copy (cwd contains 'sandbox')
  // and fails in the real working repo so that rollback happens after apply.
  writeTasksFile(tasksFilePath, {
    taskId,
    repoPath,
    branch,
    checks: [{ command: 'node', args: ['-e', "process.exit(process.cwd().includes('sandbox') ? 0 : 1)"] }],
  });

  const checkpointSha = getHeadSha(repoPath);
  const initialRemoteSha = getRemoteRef(originPath, branch);

  const result = runCli(['real-repo-run-ai', taskId], {
    ...baseEnv({ tasksFilePath, runsDir }),
    KIMI_FAKE_RESPONSE: buildFakeKimiOutput([{ path: 'README.md', content: '# modified\n' }]),
  });

  const state = loadState(runsDir, taskId);
  const finalHead = getHeadSha(repoPath);
  const finalRemote = getRemoteRef(originPath, branch);

  const expectedPolicy = 'pre_push_failure';
  const rollbackFromOutput = parseRollbackFromOutput(result.stderr);
  const actualStatus = state?.rollback?.status ?? rollbackFromOutput.status ?? 'missing';
  const actualPolicy = state?.rollback?.policy ?? rollbackFromOutput.policy ?? 'missing';

  const pass =
    result.status !== 0 &&
    actualStatus === 'succeeded' &&
    actualPolicy === expectedPolicy &&
    finalHead === checkpointSha &&
    finalRemote === initialRemoteSha &&
    isWorkingTreeClean(repoPath);

  return {
    name: 'A. Pre-push checks failure',
    expectedPolicy,
    actualStatus,
    localHeadStatus: finalHead === checkpointSha ? 'preserved' : 'changed',
    remoteRefStatus: finalRemote === initialRemoteSha ? 'preserved' : 'changed',
    workingTreeClean: isWorkingTreeClean(repoPath) ? 'yes' : 'no',
    pass,
    output: result.stderr,
  };
}

function runScenarioB(scenarioDir, taskId) {
  const { repoPath, originPath, runsDir, branch } = setupBrokenRemoteRepo(scenarioDir, taskId);
  const tasksFilePath = join(scenarioDir, 'tasks.yaml');
  writeTasksFile(tasksFilePath, { taskId, repoPath, branch });

  const checkpointSha = getHeadSha(repoPath);
  const initialRemoteSha = getRemoteRef(originPath, branch);

  const result = runCli(['real-repo-run-ai', taskId], {
    ...baseEnv({ tasksFilePath, runsDir }),
    KIMI_FAKE_RESPONSE: buildFakeKimiOutput([{ path: 'README.md', content: '# modified\n' }]),
  });

  const state = loadState(runsDir, taskId);
  const finalHead = getHeadSha(repoPath);
  const finalRemote = getRemoteRef(originPath, branch);

  const expectedPolicy = 'pre_push_failure';
  const rollbackFromOutput = parseRollbackFromOutput(result.stderr);
  const actualStatus = state?.rollback?.status ?? rollbackFromOutput.status ?? 'missing';
  const actualPolicy = state?.rollback?.policy ?? rollbackFromOutput.policy ?? 'missing';

  const pass =
    result.status !== 0 &&
    actualStatus === 'succeeded' &&
    actualPolicy === expectedPolicy &&
    finalHead === checkpointSha &&
    finalRemote === initialRemoteSha &&
    isWorkingTreeClean(repoPath);

  return {
    name: 'B. Pre-push push failure',
    expectedPolicy,
    actualStatus,
    localHeadStatus: finalHead === checkpointSha ? 'preserved' : 'changed',
    remoteRefStatus: finalRemote === initialRemoteSha ? 'preserved' : 'changed',
    workingTreeClean: isWorkingTreeClean(repoPath) ? 'yes' : 'no',
    pass,
    output: result.stderr,
  };
}

function runScenarioC(scenarioDir, taskId) {
  const { repoPath, originPath, runsDir, branch } = setupRepo(scenarioDir, taskId);
  const tasksFilePath = join(scenarioDir, 'tasks.yaml');
  writeTasksFile(tasksFilePath, { taskId, repoPath, branch });

  const checkpointSha = getHeadSha(repoPath);

  const result = runCli(['real-repo-run-ai', taskId], {
    ...baseEnv({ tasksFilePath, runsDir }),
    KIMI_FAKE_RESPONSE: buildFakeKimiOutput([{ path: 'README.md', content: '# modified\n' }]),
    REAL_REPO_REVIEWER_FAKE_RESPONSE: buildFakeReviewerResponse({
      decision: 'block_for_human',
      nextAction: 'block',
      reviewSummary: 'Human review required',
      blockingIssues: ['requires human review; token sk-reviewer-secret-1234567890'],
    }),
  });

  const state = loadState(runsDir, taskId);
  const finalHead = getHeadSha(repoPath);
  const finalRemote = getRemoteRef(originPath, branch);

  const expectedPolicy = 'post_push_preserve_for_human';
  const actualStatus = state?.rollback?.status ?? 'missing';
  const actualPolicy = state?.rollback?.policy ?? 'missing';
  const reason = state?.rollback?.reason ?? '';

  const pass =
    result.status !== 0 &&
    actualStatus === 'skipped' &&
    actualPolicy === expectedPolicy &&
    finalHead !== checkpointSha &&
    finalHead === finalRemote &&
    /pushed commit preserved|human follow-up/i.test(reason) &&
    isWorkingTreeClean(repoPath);

  return {
    name: 'C. Post-push reviewer block',
    expectedPolicy,
    actualStatus,
    localHeadStatus: finalHead === checkpointSha ? 'preserved' : 'changed',
    remoteRefStatus: finalHead === finalRemote && finalHead !== checkpointSha ? 'changed' : 'preserved',
    workingTreeClean: isWorkingTreeClean(repoPath) ? 'yes' : 'no',
    pass,
    output: result.stderr,
  };
}

function runScenarioD(scenarioDir, taskId) {
  const { repoPath, originPath, runsDir, branch } = setupRepo(scenarioDir, taskId);
  const tasksFilePath = join(scenarioDir, 'tasks.yaml');
  writeTasksFile(tasksFilePath, { taskId, repoPath, branch });

  const checkpointSha = getHeadSha(repoPath);

  const result = runCli(['real-repo-run-ai', taskId], {
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
  const finalHead = getHeadSha(repoPath);
  const finalRemote = getRemoteRef(originPath, branch);

  const expectedPolicy = 'post_push_preserve_for_human';
  const actualStatus = state?.rollback?.status ?? 'missing';
  const actualPolicy = state?.rollback?.policy ?? 'missing';

  const pass =
    result.status !== 0 &&
    actualStatus === 'skipped' &&
    actualPolicy === expectedPolicy &&
    finalHead !== checkpointSha &&
    finalHead === finalRemote &&
    isWorkingTreeClean(repoPath);

  return {
    name: 'D. Post-push reject, fix disabled',
    expectedPolicy,
    actualStatus,
    localHeadStatus: finalHead === checkpointSha ? 'preserved' : 'changed',
    remoteRefStatus: finalHead === finalRemote && finalHead !== checkpointSha ? 'changed' : 'preserved',
    workingTreeClean: isWorkingTreeClean(repoPath) ? 'yes' : 'no',
    pass,
    output: result.stderr,
  };
}

function runScenarioE(scenarioDir, taskId) {
  const { repoPath, originPath, runsDir, branch } = setupRepo(scenarioDir, taskId);
  const tasksFilePath = join(scenarioDir, 'tasks.yaml');
  writeTasksFile(tasksFilePath, { taskId, repoPath, branch });

  const checkpointSha = getHeadSha(repoPath);

  const result = runCli(['real-repo-run-ai', taskId], {
    ...baseEnv({ tasksFilePath, runsDir }),
    KIMI_FAKE_RESPONSE: buildFakeKimiOutput([{ path: 'README.md', content: '# modified\n' }]),
    REAL_REPO_REVIEWER_FAKE_RESPONSE: buildFakeReviewerResponse({
      decision: 'reject',
      nextAction: 'fix',
      reviewSummary: 'Needs fix',
      blockingIssues: ['needs fix'],
      fixTask: 'Add more detail',
    }),
    REAL_REPO_ENABLE_REVIEWER_FIX_LOOP: '1',
    REAL_REPO_REVIEWER_FIX_TASK_FAKE_EXECUTOR_RESPONSE: JSON.stringify({
      status: 'blocked',
      reason: 'Fake fix attempt failed',
      blockingIssues: ['sk-fix-secret'],
    }),
  });

  const state = loadState(runsDir, taskId);
  const finalHead = getHeadSha(repoPath);
  const finalRemote = getRemoteRef(originPath, branch);

  const expectedPolicy = 'post_push_preserve_for_human';
  const actualStatus = state?.rollback?.status ?? 'missing';
  const actualPolicy = state?.rollback?.policy ?? 'missing';
  const reason = state?.rollback?.reason ?? '';

  const pass =
    result.status !== 0 &&
    actualStatus === 'skipped' &&
    actualPolicy === expectedPolicy &&
    finalHead !== checkpointSha &&
    finalHead === finalRemote &&
    /pushed commit preserved|fix attempt rolled back locally/i.test(reason) &&
    isWorkingTreeClean(repoPath);

  return {
    name: 'E. Fix attempt fails after original push',
    expectedPolicy,
    actualStatus,
    localHeadStatus: finalHead === checkpointSha ? 'preserved' : 'changed',
    remoteRefStatus: finalHead === finalRemote && finalHead !== checkpointSha ? 'changed' : 'preserved',
    workingTreeClean: isWorkingTreeClean(repoPath) ? 'yes' : 'no',
    pass,
    output: result.stderr,
  };
}

function runScenarioF(scenarioDir, taskId) {
  const { repoPath, originPath, runsDir, branch } = setupRepo(scenarioDir, taskId);
  const tasksFilePath = join(scenarioDir, 'tasks.yaml');
  writeTasksFile(tasksFilePath, { taskId, repoPath, branch });

  const checkpointSha = getHeadSha(repoPath);

  const result = runCli(['real-repo-run-ai', taskId], {
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
  const finalHead = getHeadSha(repoPath);
  const finalRemote = getRemoteRef(originPath, branch);

  const expectedPolicy = 'post_push_preserve_for_human';
  const actualStatus = state?.rollback?.status ?? 'missing';
  const actualPolicy = state?.rollback?.policy ?? 'missing';

  const commitCountResult = runGit(repoPath, ['rev-list', '--count', branch]);
  const commitCount = parseInt(commitCountResult.stdout.trim(), 10);

  const pass =
    result.status !== 0 &&
    actualStatus === 'skipped' &&
    actualPolicy === expectedPolicy &&
    finalHead !== checkpointSha &&
    finalHead === finalRemote &&
    commitCount >= 3 &&
    isWorkingTreeClean(repoPath);

  return {
    name: 'F. Second reviewer blocks after pushed fix',
    expectedPolicy,
    actualStatus,
    localHeadStatus: finalHead === checkpointSha ? 'preserved' : 'changed',
    remoteRefStatus: finalHead === finalRemote && finalHead !== checkpointSha ? 'changed' : 'preserved',
    workingTreeClean: isWorkingTreeClean(repoPath) ? 'yes' : 'no',
    pass,
    output: result.stderr,
  };
}

function printTable(results) {
  const header = [
    'Scenario'.padEnd(42),
    'Expected policy'.padEnd(26),
    'Rollback status'.padEnd(16),
    'Local HEAD'.padEnd(12),
    'Remote ref'.padEnd(12),
    'WT clean'.padEnd(10),
    'Pass/Fail'.padEnd(10),
  ].join(' | ');
  console.log(header);
  console.log('-'.repeat(header.length));
  for (const r of results) {
    const line = [
      r.name.padEnd(42),
      r.expectedPolicy.padEnd(26),
      String(r.actualStatus).padEnd(16),
      r.localHeadStatus.padEnd(12),
      r.remoteRefStatus.padEnd(12),
      r.workingTreeClean.padEnd(10),
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
  const keepTemp = process.env.ROLLBACK_DRILL_KEEP_TEMP === '1';

  if (args.listScenarios) {
    console.log('Scenarios: A B C D E F');
    if (!keepTemp) rmSync(workspace, { recursive: true, force: true });
    return;
  }

  console.log(`Rollback policy drill workspace: ${workspace}`);
  console.log('Using local bare remotes only. No live provider calls.');
  console.log('');

  const scenarios = [
    { run: () => runScenarioA(createScenarioWorkspace(workspace, 'A'), 'drill-a'), key: 'A' },
    { run: () => runScenarioB(createScenarioWorkspace(workspace, 'B'), 'drill-b'), key: 'B' },
    { run: () => runScenarioC(createScenarioWorkspace(workspace, 'C'), 'drill-c'), key: 'C' },
    { run: () => runScenarioD(createScenarioWorkspace(workspace, 'D'), 'drill-d'), key: 'D' },
    { run: () => runScenarioE(createScenarioWorkspace(workspace, 'E'), 'drill-e'), key: 'E' },
    { run: () => runScenarioF(createScenarioWorkspace(workspace, 'F'), 'drill-f'), key: 'F' },
  ];

  const forceFail = process.env.ROLLBACK_DRILL_FORCE_FAIL || '';

  const results = [];
  let anyFailed = false;
  for (const { run, key } of scenarios) {
    let result;
    try {
      result = run();
    } catch (err) {
      result = {
        name: 'unknown',
        expectedPolicy: 'unknown',
        actualStatus: 'error',
        localHeadStatus: 'unknown',
        remoteRefStatus: 'unknown',
        workingTreeClean: 'unknown',
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

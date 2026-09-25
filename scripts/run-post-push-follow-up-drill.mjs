#!/usr/bin/env node
/**
 * Post-push follow-up drill (Stage 18.26h adaptation).
 *
 * Stage 18.26 moved the reviewer gate BEFORE the push: a blocked or rejected
 * task never produces a pushed commit, so there is no
 * "post_push_preserve_for_human" state anymore. The follow-up command
 * (`real-repo-follow-up`) is intentionally fail-closed for such states: it
 * refuses to build follow-ups without a preserved pushed commit.
 *
 * This adaptation preserves the drill's SAFETY SEMANTICS with the current
 * architecture:
 *
 *   - blocked/rejected tasks leave NO pushed commit on the remote;
 *   - the follow-up command refuses (fail closed) for pre-push blocked
 *     states instead of inventing a follow-up;
 *   - the repository is never mutated by the follow-up command;
 *   - secrets in reviewer evidence are redacted everywhere;
 *   - corrupted state is refused.
 *
 * All scenarios use local bare remotes and fake provider responses only.
 * No live provider calls are made.
 *
 * Env:
 *   POST_PUSH_FOLLOW_UP_DRILL_KEEP_TEMP=1   preserve the temp workspace
 *   POST_PUSH_FOLLOW_UP_DRILL_FORCE_FAIL=A  force scenario A to report FAIL
 *   --workspace <abs path>
 *   --list-scenarios
 */
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

const SECRET_KEY = 'secret-follow-up-drill-key';
const SECRET_TOKEN = 'secret-follow-up-drill-token';

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

function loadState(runsDir, taskId) {
  const statePath = join(runsDir, taskId, 'state.json');
  if (!existsSync(statePath)) return null;
  return JSON.parse(readFileSync(statePath, 'utf8'));
}

function saveState(runsDir, taskId, state) {
  const statePath = join(runsDir, taskId, 'state.json');
  writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf8');
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

function isPathInsideOrEqual(child, parent) {
  const rChild = resolve(child);
  const rParent = resolve(parent);
  if (rChild === rParent) return true;
  return rChild.toLowerCase().startsWith(rParent.toLowerCase() + '\\') || rChild.startsWith(rParent + '/');
}

function createWorkspace(baseDir) {
  return mkdtempSync(join(baseDir, 'follow-up-drill-'));
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

function writeTasksFile(tasksFilePath, { taskId, repoPath, branch }) {
  writeFileSync(
    tasksFilePath,
    `tasks:
  - id: ${taskId}
    title: "Follow-up drill ${taskId}"
    repo_path: "${repoPath.replace(/\\/g, '/')}"
    base_branch: "main"
    work_branch: "${branch}"
    goal: "Drill post-push follow-up"
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
    REAL_REPO_REVIEWER_MAX_FIX_ATTEMPTS: '1',
    KIMI_API_KEY: FAKE_API_KEY,
    KIMI_BASE_URL: FAKE_BASE_URL,
  };
}

/**
 * Shared scenario driver: run a task whose reviewer blocks for a human, with
 * secret-like strings in the reviewer evidence to prove redaction.
 * Under the current architecture the block happens BEFORE any push.
 */
function runBlockedPrePushScenario(scenarioDir, taskId, reviewerEnv) {
  const { repoPath, originPath, runsDir, branch } = setupRepo(scenarioDir, taskId);
  const tasksFilePath = join(scenarioDir, 'tasks.yaml');
  writeTasksFile(tasksFilePath, { taskId, repoPath, branch });

  const checkpointSha = getHeadSha(repoPath);

  const runResult = runCli(['real-repo-run-ai', taskId], {
    ...baseEnv({ tasksFilePath, runsDir }),
    KIMI_FAKE_RESPONSE: buildFakeKimiOutput([{ path: 'README.md', content: '# modified\n' }]),
    ...reviewerEnv,
  });

  const state = loadState(runsDir, taskId);
  const output = `${runResult.stdout}\n${runResult.stderr}`;

  // Universal safety invariants for a blocked run: non-zero exit, nothing
  // pushed, repository exactly at the checkpoint, working tree clean.
  const runPass =
    runResult.status !== 0 &&
    state?.pushed !== true &&
    getHeadSha(repoPath) === checkpointSha &&
    isWorkingTreeClean(repoPath) &&
    getHeadSha(originPath ? repoPath : repoPath) === checkpointSha;

  return { state, repoPath, originPath, runsDir, branch, tasksFilePath, checkpointSha, runPass, output };
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

const BLOCK_REVIEWER = {
  REAL_REPO_REVIEWER_FAKE_RESPONSE: buildFakeReviewerResponse({
    decision: 'block_for_human',
    nextAction: 'block',
    reviewSummary: 'Human review required',
    blockingIssues: [
      `api_key=${SECRET_KEY}`,
      `token=${SECRET_TOKEN}`,
      'needs human review',
    ],
  }),
};

/**
 * Fail-closed refusal shape shared by scenarios A–E: the follow-up command
 * must refuse to derive a follow-up from a state with no preserved pushed
 * commit, must not mutate the repository, and must not leak secrets.
 */
function refusalPass(result, repoPath, checkpointSha) {
  const output = `${result.stdout}\n${result.stderr}`;
  return (
    result.status !== 0 &&
    output.includes('State has no rollback record') &&
    !output.includes('Preserved original commit') &&
    output.includes('No provider call was made') &&
    output.includes('No repository mutation was performed') &&
    !output.includes(SECRET_KEY) &&
    !output.includes(SECRET_TOKEN) &&
    isWorkingTreeClean(repoPath) &&
    getHeadSha(repoPath) === checkpointSha
  );
}

function runScenarioA(scenarioDir, taskId) {
  const ctx = runBlockedPrePushScenario(scenarioDir, taskId, BLOCK_REVIEWER);
  if (!ctx.runPass) {
    return { name: 'A. Reviewer block → follow-up refused', pass: false, output: ctx.output, state: ctx.state?.status ?? 'missing' };
  }

  const followUpResult = runReportOnlyFollowUp({ runsDir: ctx.runsDir, taskId });
  const pass = refusalPass(followUpResult, ctx.repoPath, ctx.checkpointSha);

  return {
    name: 'A. Reviewer block → follow-up refused',
    pass,
    output: `${followUpResult.stdout}\n${followUpResult.stderr}`,
    state: ctx.state?.status ?? 'missing',
    repoUnchanged: getHeadSha(ctx.repoPath) === ctx.checkpointSha && isWorkingTreeClean(ctx.repoPath),
    redactionPassed: 'checked',
  };
}

function runScenarioB(scenarioDir, taskId) {
  const ctx = runBlockedPrePushScenario(scenarioDir, taskId, {
    REAL_REPO_REVIEWER_FAKE_RESPONSE: buildFakeReviewerResponse({
      decision: 'reject',
      nextAction: 'fix',
      reviewSummary: 'Needs fix',
      blockingIssues: [`api_key=${SECRET_KEY}`, 'needs fix'],
      fixTask: 'Add more detail',
    }),
    REAL_REPO_REVIEWER_FIX_TASK_KIMI_FAKE_RESPONSE: buildFakeKimiOutput([], 'no effective changes'),
  });
  if (!ctx.runPass) {
    return { name: 'B. Reject/fix-failed → follow-up refused', pass: false, output: ctx.output, state: ctx.state?.status ?? 'missing' };
  }

  const followUpResult = runReportOnlyFollowUp({ runsDir: ctx.runsDir, taskId });
  const pass = refusalPass(followUpResult, ctx.repoPath, ctx.checkpointSha);

  return {
    name: 'B. Reject/fix-failed → follow-up refused',
    pass,
    output: `${followUpResult.stdout}\n${followUpResult.stderr}`,
    state: ctx.state?.status ?? 'missing',
    repoUnchanged: getHeadSha(ctx.repoPath) === ctx.checkpointSha && isWorkingTreeClean(ctx.repoPath),
    redactionPassed: 'checked',
  };
}

function runScenarioC(scenarioDir, taskId) {
  const ctx = runBlockedPrePushScenario(scenarioDir, taskId, {
    REAL_REPO_REVIEWER_FAKE_RESPONSE: buildFakeReviewerResponse({
      decision: 'reject',
      nextAction: 'fix',
      reviewSummary: 'Needs fix',
      blockingIssues: [`token=${SECRET_TOKEN}`, 'needs fix'],
      fixTask: 'Add fix detail',
    }),
    REAL_REPO_REVIEWER_FIX_TASK_KIMI_FAKE_RESPONSE: buildFakeKimiOutput([{ path: 'fix.txt', content: 'fix applied\n' }]),
    REAL_REPO_REVIEWER_SECOND_FAKE_RESPONSE: buildFakeReviewerResponse({
      decision: 'block_for_human',
      nextAction: 'block',
      reviewSummary: 'Second reviewer blocked',
      blockingIssues: ['second reviewer requires human review'],
    }),
  });
  if (!ctx.runPass) {
    return { name: 'C. Second reviewer block after fix → refused', pass: false, output: ctx.output, state: ctx.state?.status ?? 'missing' };
  }

  const followUpResult = runReportOnlyFollowUp({ runsDir: ctx.runsDir, taskId });
  const pass = refusalPass(followUpResult, ctx.repoPath, ctx.checkpointSha);

  return {
    name: 'C. Second reviewer block after fix → refused',
    pass,
    output: `${followUpResult.stdout}\n${followUpResult.stderr}`,
    state: ctx.state?.status ?? 'missing',
    repoUnchanged: getHeadSha(ctx.repoPath) === ctx.checkpointSha && isWorkingTreeClean(ctx.repoPath),
    redactionPassed: 'checked',
  };
}

function runScenarioD(scenarioDir, taskId, newTaskId) {
  const ctx = runBlockedPrePushScenario(scenarioDir, taskId, BLOCK_REVIEWER);
  if (!ctx.runPass) {
    return { name: 'D. Create follow-up refused, no file created', pass: false, output: ctx.output, state: ctx.state?.status ?? 'missing' };
  }

  const createResult = runCreateFollowUp({ runsDir: ctx.runsDir, taskId, newTaskId });
  const createOutput = `${createResult.stdout}\n${createResult.stderr}`;
  const followUpFilePath = join(ctx.runsDir, taskId, `follow-up-${newTaskId}.yaml`);

  const pass =
    createResult.status !== 0 &&
    !existsSync(followUpFilePath) &&
    createOutput.includes('State has no rollback record') &&
    createOutput.includes('No provider call was made') &&
    createOutput.includes('No repository mutation was performed') &&
    isWorkingTreeClean(ctx.repoPath) &&
    getHeadSha(ctx.repoPath) === ctx.checkpointSha;

  return {
    name: 'D. Create follow-up refused, no file created',
    pass,
    output: createOutput,
    state: ctx.state?.status ?? 'missing',
    repoUnchanged: getHeadSha(ctx.repoPath) === ctx.checkpointSha && isWorkingTreeClean(ctx.repoPath),
    redactionPassed: 'n/a',
  };
}

function runScenarioE(scenarioDir, taskId) {
  const ctx = runBlockedPrePushScenario(scenarioDir, taskId, BLOCK_REVIEWER);
  if (!ctx.runPass) {
    return { name: 'E. Redaction proof', pass: false, output: ctx.output, state: ctx.state?.status ?? 'missing' };
  }

  const followUpResult = runReportOnlyFollowUp({ runsDir: ctx.runsDir, taskId });
  const followUpOutput = `${followUpResult.stdout}\n${followUpResult.stderr}`;
  const newTaskId = `${taskId}-follow-up`;
  const createResult = runCreateFollowUp({ runsDir: ctx.runsDir, taskId, newTaskId });
  const createOutput = `${createResult.stdout}\n${createResult.stderr}`;
  const followUpFilePath = join(ctx.runsDir, taskId, `follow-up-${newTaskId}.yaml`);

  // The blocked run's persisted reviewer evidence must already be redacted,
  // and neither the refusal report nor any created file may leak the secrets.
  const stateRaw = readFileSync(join(ctx.runsDir, taskId, 'state.json'), 'utf8');
  const pass =
    followUpResult.status !== 0 &&
    createResult.status !== 0 &&
    !followUpOutput.includes(SECRET_KEY) &&
    !followUpOutput.includes(SECRET_TOKEN) &&
    !createOutput.includes(SECRET_KEY) &&
    !createOutput.includes(SECRET_TOKEN) &&
    !stateRaw.includes(SECRET_KEY) &&
    !stateRaw.includes(SECRET_TOKEN) &&
    (followUpOutput.includes('[REDACTED]') || stateRaw.includes('[REDACTED]')) &&
    !existsSync(followUpFilePath);

  return {
    name: 'E. Redaction proof',
    pass,
    output: `${followUpOutput}\n${createOutput}`,
    state: ctx.state?.status ?? 'missing',
    repoUnchanged: isWorkingTreeClean(ctx.repoPath),
    redactionPassed: pass ? 'yes' : 'no',
  };
}

function runScenarioF(scenarioDir, taskId) {
  const ctx = runBlockedPrePushScenario(scenarioDir, taskId, BLOCK_REVIEWER);
  if (!ctx.runPass) {
    return { name: 'F. Corrupted state task_id → refused', pass: false, output: ctx.output, state: ctx.state?.status ?? 'missing' };
  }

  const corruptedState = loadState(ctx.runsDir, taskId);
  corruptedState.task_id = 'corrupted-task-id';
  saveState(ctx.runsDir, taskId, corruptedState);

  const followUpResult = runReportOnlyFollowUp({ runsDir: ctx.runsDir, taskId });
  const followUpOutput = `${followUpResult.stdout}\n${followUpResult.stderr}`;

  const pass =
    followUpResult.status !== 0 &&
    followUpOutput.includes('task_id mismatch') &&
    followUpOutput.includes('No provider call was made') &&
    followUpOutput.includes('No repository mutation was performed') &&
    isWorkingTreeClean(ctx.repoPath) &&
    getHeadSha(ctx.repoPath) === ctx.checkpointSha;

  return {
    name: 'F. Corrupted state task_id → refused',
    pass,
    output: followUpOutput,
    state: 'corrupted',
    repoUnchanged: getHeadSha(ctx.repoPath) === ctx.checkpointSha && isWorkingTreeClean(ctx.repoPath),
    redactionPassed: 'n/a',
  };
}

function printTable(results) {
  const header = [
    'Scenario'.padEnd(48),
    'State'.padEnd(12),
    'Repo unchanged'.padEnd(15),
    'Redaction'.padEnd(10),
    'Pass/Fail'.padEnd(10),
  ].join(' | ');
  console.log(header);
  console.log('-'.repeat(header.length));
  for (const r of results) {
    const line = [
      r.name.padEnd(48),
      String(r.state ?? 'n/a').padEnd(12),
      String(r.repoUnchanged ? 'yes' : 'no').padEnd(15),
      String(r.redactionPassed ?? 'n/a').padEnd(10),
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
  const keepTemp = process.env.POST_PUSH_FOLLOW_UP_DRILL_KEEP_TEMP === '1';

  if (args.listScenarios) {
    console.log('Scenarios: A B C D E F');
    if (!keepTemp) rmSync(workspace, { recursive: true, force: true });
    return;
  }

  console.log(`Post-push follow-up drill workspace: ${workspace}`);
  console.log('Using local bare remotes only. No live provider calls.');
  console.log('The reviewer gate runs before push: blocked tasks have no preserved');
  console.log('pushed commit, so follow-up derivation must refuse fail-closed.');
  console.log('');

  const scenarios = [
    { run: () => runScenarioA(createScenarioWorkspace(workspace, 'A'), 'drill-a'), key: 'A' },
    { run: () => runScenarioB(createScenarioWorkspace(workspace, 'B'), 'drill-b'), key: 'B' },
    { run: () => runScenarioC(createScenarioWorkspace(workspace, 'C'), 'drill-c'), key: 'C' },
    { run: () => runScenarioD(createScenarioWorkspace(workspace, 'D'), 'drill-d', 'drill-d-follow-up'), key: 'D' },
    { run: () => runScenarioE(createScenarioWorkspace(workspace, 'E'), 'drill-e'), key: 'E' },
    { run: () => runScenarioF(createScenarioWorkspace(workspace, 'F'), 'drill-f'), key: 'F' },
  ];

  const forceFail = process.env.POST_PUSH_FOLLOW_UP_DRILL_FORCE_FAIL || '';

  const results = [];
  let anyFailed = false;
  for (const { run, key } of scenarios) {
    let result;
    try {
      result = run();
    } catch (err) {
      result = {
        name: 'unknown',
        state: 'error',
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

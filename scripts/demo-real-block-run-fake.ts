import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { loadBlockDefinition } from '../src/block/block-loader.js';

const PROJECT_ROOT = resolve(process.cwd());
const CLI_PATH = join(PROJECT_ROOT, 'src', 'cli.ts');
const TSX_CLI_PATH = join(PROJECT_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');

interface DemoPaths {
  tmpDir: string;
  repoPath: string;
  originPath: string;
  runsDir: string;
  blockPath: string;
  blockId: string;
}

const DEMO_GIT_USER_EMAIL = 'demo@example.invalid';
const DEMO_GIT_USER_NAME = 'AI Orchestrator Demo';

function runGit(args: string[], cwd: string): void {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf-8',
    shell: false,
  });

  if (result.status !== 0) {
    const command = args[0] ?? 'command';
    throw new Error(`git ${command} failed with exit code ${result.status}`);
  }
}

function getGitOutput(args: string[], cwd: string): string {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf-8',
    shell: false,
  });

  if (result.status !== 0) {
    const command = args[0] ?? 'command';
    throw new Error(`git ${command} failed with exit code ${result.status}`);
  }

  return result.stdout.trim();
}

function runCli(args: string[], env: NodeJS.ProcessEnv): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, [TSX_CLI_PATH, CLI_PATH, ...args], {
    cwd: PROJECT_ROOT,
    env,
    encoding: 'utf-8',
    shell: false,
    timeout: 120000,
  });
}

function buildFakeKimiOutput(files: Array<{ path: string; content: string }>): string {
  return JSON.stringify({ mode: 'file_update', files });
}

function buildAcceptReview(summary: string): string {
  return JSON.stringify({
    decision: 'accept',
    confidence: 'high',
    blockingIssues: [],
    nonBlockingIssues: [],
    reviewSummary: summary,
    nextAction: 'continue',
  });
}

function buildRejectReview(summary: string, blockingIssues: string[], fixTask: string): string {
  return JSON.stringify({
    decision: 'reject',
    confidence: 'high',
    blockingIssues,
    nonBlockingIssues: [],
    reviewSummary: summary,
    nextAction: 'fix',
    fixTask,
  });
}

function createTempRepo(repoPath: string, originPath: string): void {
  mkdirSync(repoPath, { recursive: true });
  writeFileSync(join(repoPath, 'README.md'), '# Demo repo\n', 'utf-8');

  runGit(['init'], repoPath);
  runGit(['config', 'user.email', DEMO_GIT_USER_EMAIL], repoPath);
  runGit(['config', 'user.name', DEMO_GIT_USER_NAME], repoPath);
  runGit(['add', '.'], repoPath);
  runGit(['commit', '-m', 'init', '--no-gpg-sign'], repoPath);
  runGit(['branch', '-m', 'main'], repoPath);
  runGit(['checkout', '-b', 'ai-block-demo'], repoPath);

  mkdirSync(originPath, { recursive: true });
  runGit(['init', '--bare'], originPath);
  runGit(['remote', 'add', 'origin', originPath], repoPath);

  assertRepoSetup(repoPath);
}

function assertRepoSetup(repoPath: string): void {
  if (!existsSync(join(repoPath, '.git'))) {
    throw new Error('Temp repo setup failed: .git directory is missing');
  }

  const currentBranch = getGitOutput(['rev-parse', '--abbrev-ref', 'HEAD'], repoPath);
  if (currentBranch !== 'ai-block-demo') {
    throw new Error(`Temp repo setup failed: current branch is ${currentBranch}, expected ai-block-demo`);
  }

  const logCount = getGitOutput(['log', '--oneline'], repoPath)
    .split('\n')
    .filter((line) => line.length > 0).length;
  if (logCount < 1) {
    throw new Error('Temp repo setup failed: no baseline commit found');
  }
}


function buildDemoEnv(paths: DemoPaths): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    RUNS_DIR: paths.runsDir,
    ALLOW_REAL_BLOCK_RUN_AI: 'true',
    ALLOW_REAL_PROVIDER: 'true',
    ALLOW_REAL_REPO_APPLY: 'true',
    ALLOW_REAL_REPO_COMMIT: 'true',
    ALLOW_REAL_REPO_PUSH: 'true',
    KIMI_API_KEY: 'sk-demo-placeholder',
    KIMI_BASE_URL: 'http://localhost.invalid',
    KIMI_MODEL: 'kimi-k2.6',
    REAL_REPO_ENABLE_REVIEWER_FIX_LOOP: '1',
    REAL_BLOCK_TASK_KIMI_FAKE_RESPONSES: JSON.stringify([
      buildFakeKimiOutput([{ path: 'README.md', content: '# Demo repo\n\nUpdated by task 1.\n' }]),
      buildFakeKimiOutput([{ path: 'feature.txt', content: 'feature content\n' }]),
    ]),
    REAL_BLOCK_TASK_REVIEWER_FAKE_RESPONSES: JSON.stringify([
      buildAcceptReview('Task 1 accepted'),
      buildRejectReview('Task 2 needs fix', ['add fix detail'], 'add fix detail'),
    ]),
    REAL_BLOCK_TASK_FIX_KIMI_FAKE_RESPONSES: JSON.stringify([
      null,
      buildFakeKimiOutput([{ path: 'feature.txt', content: 'feature content\nfix applied\n' }]),
    ]),
    REAL_BLOCK_TASK_SECOND_REVIEWER_FAKE_RESPONSES: JSON.stringify([
      null,
      buildAcceptReview('Task 2 fix accepted'),
    ]),
  };
  return env;
}

function setupDemo(): DemoPaths {
  const tmpDir = mkdtempSync(join(tmpdir(), 'ai-orchestrator-demo-'));
  const repoPath = join(tmpDir, 'repo');
  const originPath = join(tmpDir, 'origin.git');
  const runsDir = join(tmpDir, 'runs');
  const blockPath = join(tmpDir, 'block.json');

  createTempRepo(repoPath, originPath);
  const blockId = 'block_smoke';

  return { tmpDir, repoPath, originPath, runsDir, blockPath, blockId };
}

function printSection(title: string): void {
  console.log(`\n=== ${title} ===`);
}

function printResult(label: string, value: unknown): void {
  console.log(`${label}: ${value}`);
}

function loadState(statePath: string): Record<string, unknown> | null {
  if (!existsSync(statePath)) {
    return null;
  }
  return JSON.parse(readFileSync(statePath, 'utf-8'));
}

async function main(): Promise<void> {
  const keepArtifacts = process.env.KEEP_DEMO_ARTIFACTS === '1';

  printSection('AI Orchestrator — local fake block run demo');
  console.log('This demo uses fake responses and does not call real external AI.');

  const paths = setupDemo();

  try {
    printSection('Paths');
    printResult('Temp repo', paths.repoPath);
    printResult('Block file', paths.blockPath);
    printResult('Runs dir', paths.runsDir);

    const env = buildDemoEnv(paths);

    function parseJsonOutput(result: ReturnType<typeof runCli>, label: string): Record<string, unknown> {
      const output = (result.stdout || '') + (result.stderr || '');
      if (result.status !== 0) {
        console.error(output);
        throw new Error(`${label} failed with exit code ${result.status}`);
      }
      const match = output.match(/\{[\s\S]*\}/);
      if (!match) {
        throw new Error(`${label} output did not contain JSON`);
      }
      try {
        return JSON.parse(match[0]) as Record<string, unknown>;
      } catch {
        throw new Error(`${label} output contained invalid JSON`);
      }
    }

    printSection('Block init');
    const initResult = runCli(
      [
        'real-block-init',
        paths.blockPath,
        '--block-id',
        paths.blockId,
        '--title',
        'Local fake block run demo',
        '--repo-path',
        paths.repoPath.replace(/\\/g, '/'),
        '--base-branch',
        'main',
        '--work-branch',
        'ai-block-demo',
        '--task-id',
        'task_1',
        '--task-title',
        'Update README',
      ],
      env
    );
    const initOutput = (initResult.stdout || '') + (initResult.stderr || '');
    const initReport = parseJsonOutput(initResult, 'Block init');
    console.log(initOutput);
    if (initReport.ok !== true) {
      throw new Error('Expected block init report ok to be true');
    }
    if (initReport.mode !== 'real-block-init') {
      throw new Error('Expected block init mode real-block-init');
    }
    if (initReport.blockId !== paths.blockId) {
      throw new Error(`Expected block init blockId ${paths.blockId}, got ${String(initReport.blockId)}`);
    }
    if (initReport.taskCount !== 1) {
      throw new Error(`Expected block init taskCount 1, got ${String(initReport.taskCount)}`);
    }
    const initCommands = Array.isArray(initReport.nextCommands) ? initReport.nextCommands : [];
    if (!initCommands.some((c: unknown) => typeof c === 'string' && c.includes('real-block-run-ai-checklist'))) {
      throw new Error('Expected block init nextCommands to include checklist command');
    }
    if (!initCommands.some((c: unknown) => typeof c === 'string' && c.includes('real-block-run-ai-dry-run'))) {
      throw new Error('Expected block init nextCommands to include dry-run command');
    }
    if (initOutput.includes('sk-demo-placeholder')) {
      throw new Error('Block init output leaked fake demo secret');
    }
    console.log('Block init: passed');

    printSection('Generated block edited for demo');
    const generatedBlock = JSON.parse(readFileSync(paths.blockPath, 'utf-8')) as Record<string, unknown>;
    if (!Array.isArray(generatedBlock.tasks) || generatedBlock.tasks.length !== 1) {
      throw new Error('Expected generated starter block to contain exactly one task');
    }
    const editedBlock = {
      ...generatedBlock,
      tasks: [
        {
          task_id: 'task_1',
          title: 'Update README',
          goal: 'Update README with demo content.',
          allowed_files: ['README.md'],
          denied_files: [],
          max_lines_changed: 100,
          checks: [],
        },
        {
          task_id: 'task_2',
          title: 'Add feature note',
          goal: 'Add a feature note file.',
          allowed_files: ['feature.txt'],
          denied_files: [],
          max_lines_changed: 100,
          checks: [],
        },
      ],
    };
    writeFileSync(paths.blockPath, JSON.stringify(editedBlock, null, 2), 'utf-8');
    const loadedEditedBlock = loadBlockDefinition(paths.blockPath);
    if (loadedEditedBlock.work_branch === 'main') {
      throw new Error('Edited block work_branch must not be main');
    }
    if (loadedEditedBlock.providers.coder.provider !== 'kimi' || loadedEditedBlock.providers.reviewer.provider !== 'kimi') {
      throw new Error('Edited block providers must be kimi');
    }
    const editedTaskIds = loadedEditedBlock.tasks.map((t) => t.task_id);
    if (!editedTaskIds.includes('task_1') || !editedTaskIds.includes('task_2')) {
      throw new Error('Edited block tasks must include task_1 and task_2');
    }
    const editedBlockRaw = readFileSync(paths.blockPath, 'utf-8');
    if (editedBlockRaw.includes('sk-demo-placeholder')) {
      throw new Error('Edited block file leaked fake demo secret');
    }
    console.log('Generated block edited for demo: passed');

    printSection('Real run checklist');
    const checklistResult = runCli(['real-block-run-ai-checklist', paths.blockPath], env);
    const checklistOutput = (checklistResult.stdout || '') + (checklistResult.stderr || '');
    const checklistReport = parseJsonOutput(checklistResult, 'Real run checklist');
    console.log(checklistOutput);
    if (checklistReport.ok !== true) {
      throw new Error('Expected checklist report ok to be true');
    }
    if (checklistReport.mode !== 'real-block-run-ai-checklist') {
      throw new Error('Expected checklist mode real-block-run-ai-checklist');
    }
    const checklistBlockReadiness = checklistReport.blockReadiness as Record<string, unknown> | undefined;
    if (!checklistBlockReadiness || checklistBlockReadiness.ready !== true) {
      throw new Error('Expected checklist blockReadiness.ready to be true');
    }
    const checklistProviderSmoke = checklistReport.providerSmoke as Record<string, unknown> | undefined;
    if (!checklistProviderSmoke || checklistProviderSmoke.envReady !== true) {
      throw new Error('Expected checklist providerSmoke.envReady to be true');
    }
    const checklistCommands = Array.isArray(checklistReport.nextCommands) ? checklistReport.nextCommands : [];
    if (!checklistCommands.some((c: unknown) => typeof c === 'string' && c.includes('real-provider-smoke'))) {
      throw new Error('Expected checklist nextCommands to include provider smoke command');
    }
    if (!checklistCommands.some((c: unknown) => typeof c === 'string' && c.includes('real-block-run-ai'))) {
      throw new Error('Expected checklist nextCommands to include real block run command');
    }
    if (checklistOutput.includes('sk-demo-placeholder')) {
      throw new Error('Checklist output leaked fake demo secret');
    }
    console.log('Real run checklist: passed');

    printSection('Dry-run');
    const dryRunResult = runCli(['real-block-run-ai-dry-run', paths.blockPath], env);
    const dryRunOutput = (dryRunResult.stdout || '') + (dryRunResult.stderr || '');
    const dryRunReport = parseJsonOutput(dryRunResult, 'Dry-run');
    console.log(dryRunOutput);
    if (dryRunReport.ok !== true) {
      throw new Error('Expected dry-run report ok to be true');
    }
    if (dryRunReport.mode !== 'real-block-run-ai-dry-run') {
      throw new Error('Expected dry-run mode real-block-run-ai-dry-run');
    }
    const dryRunReadiness = dryRunReport.readiness as Record<string, unknown> | undefined;
    if (!dryRunReadiness || dryRunReadiness.ready !== true) {
      throw new Error('Expected dry-run readiness.ready to be true');
    }
    const dryRunProviderSmoke = dryRunReport.providerSmoke as Record<string, unknown> | undefined;
    if (!dryRunProviderSmoke || dryRunProviderSmoke.envReady !== true) {
      throw new Error('Expected dry-run providerSmoke.envReady to be true');
    }
    const dryRunTasks = Array.isArray(dryRunReport.tasks) ? dryRunReport.tasks : [];
    const taskIds = dryRunTasks.map((t: unknown) => (t as Record<string, unknown>).task_id);
    if (!taskIds.includes('task_1') || !taskIds.includes('task_2')) {
      throw new Error('Expected dry-run tasks to include task_1 and task_2');
    }
    const nextTasks = dryRunTasks.filter((t: unknown) => (t as Record<string, unknown>).isNext === true);
    if (nextTasks.length !== 1) {
      throw new Error(`Expected exactly one next task in dry-run, got ${nextTasks.length}`);
    }
    const dryRunCommands = Array.isArray(dryRunReport.nextCommands) ? dryRunReport.nextCommands : [];
    if (!dryRunCommands.some((c: unknown) => typeof c === 'string' && c.includes('real-provider-smoke'))) {
      throw new Error('Expected dry-run nextCommands to include provider smoke command');
    }
    if (!dryRunCommands.some((c: unknown) => typeof c === 'string' && c.includes('real-block-run-ai'))) {
      throw new Error('Expected dry-run nextCommands to include real block run command');
    }
    if (!dryRunCommands.some((c: unknown) => typeof c === 'string' && c.includes('real-block-run-ai-report'))) {
      throw new Error('Expected dry-run nextCommands to include report command');
    }
    if (dryRunOutput.includes('sk-demo-placeholder')) {
      throw new Error('Dry-run output leaked fake demo secret');
    }
    console.log('Dry-run: passed');

    printSection('Readiness check');
    const readinessResult = runCli(['real-block-run-ai-readiness', paths.blockPath], env);
    const readinessOutput = (readinessResult.stdout || '') + (readinessResult.stderr || '');
    if (readinessResult.status !== 0) {
      console.error(readinessOutput);
      throw new Error(`Readiness check failed with exit code ${readinessResult.status}`);
    }
    console.log(readinessOutput);
    console.log('Readiness: passed');

    printSection('Block run');
    const runResult = runCli(['real-block-run-ai', paths.blockPath], env);
    const runOutput = (runResult.stdout || '') + (runResult.stderr || '');
    console.log(runOutput);
    if (runResult.status !== 0) {
      throw new Error(`Block run failed with exit code ${runResult.status}`);
    }

    const statePath = join(paths.runsDir, 'block', paths.blockId, 'state.json');
    const state = loadState(statePath);

    printSection('Result summary');
    printResult('Final state path', statePath);
    printResult('Block status', state?.status ?? 'unknown');

    const taskResults = Array.isArray(state?.taskResults) ? state.taskResults : [];
    for (const task of taskResults) {
      const t = task as Record<string, unknown>;
      printResult(`Task ${t.taskId}`, `${t.status} (final: ${t.finalStatus}, next: ${t.nextAction})`);
      if (t.originalCommitSha) {
        printResult(`  original commit`, t.originalCommitSha);
      }
      if (t.fixCommitSha) {
        printResult(`  fix commit`, t.fixCommitSha);
      }
    }

    if (state?.status !== 'completed') {
      throw new Error(`Expected block status completed, got ${String(state?.status)}`);
    }

    const task1 = taskResults.find((t: unknown) => (t as Record<string, unknown>).taskId === 'task_1');
    const task2 = taskResults.find((t: unknown) => (t as Record<string, unknown>).taskId === 'task_2');

    if (!task1 || (task1 as Record<string, unknown>).status !== 'accepted') {
      throw new Error('Expected task_1 status accepted');
    }
    if (!task2 || (task2 as Record<string, unknown>).status !== 'fixed_and_accepted') {
      throw new Error('Expected task_2 status fixed_and_accepted');
    }

    const fixCommitSha = (task2 as Record<string, unknown>).fixCommitSha;
    if (typeof fixCommitSha !== 'string' || fixCommitSha.length !== 40) {
      throw new Error('Expected task_2 fixCommitSha to be a 40-char string');
    }

    printSection('Block report');
    const reportResult = runCli(['real-block-run-ai-report', statePath], env);
    const reportOutput = (reportResult.stdout || '') + (reportResult.stderr || '');
    console.log(reportOutput);
    if (reportResult.status !== 0) {
      throw new Error(`Block report command failed with exit code ${reportResult.status}`);
    }
    if (!reportOutput.includes('Block Run Report')) {
      throw new Error('Block report output is missing Block Run Report header');
    }
    if (!reportOutput.includes(`Block: ${paths.blockId}`)) {
      throw new Error('Block report output is missing demo block id');
    }
    if (!reportOutput.includes('Status: completed')) {
      throw new Error('Block report output is missing completed status');
    }
    if (!reportOutput.includes('task_1')) {
      throw new Error('Block report output is missing task_1');
    }
    if (!reportOutput.includes('accepted')) {
      throw new Error('Block report output is missing accepted status');
    }
    if (!reportOutput.includes('task_2')) {
      throw new Error('Block report output is missing task_2');
    }
    if (!reportOutput.includes('fixed_and_accepted')) {
      throw new Error('Block report output is missing fixed_and_accepted status');
    }
    if (!reportOutput.includes('fixCommitSha')) {
      throw new Error('Block report output is missing fixCommitSha field');
    }
    if (reportOutput.includes('sk-demo-placeholder')) {
      throw new Error('Block report output leaked fake demo secret');
    }

    printSection('Demo completed successfully');
    console.log('No real AI was called. No push to external remote was performed.');
    if (keepArtifacts) {
      console.log(`Artifacts kept at: ${paths.tmpDir}`);
    }
  } finally {
    if (!keepArtifacts) {
      rmSync(paths.tmpDir, { recursive: true, force: true });
    }
  }
}

main().catch((err) => {
  console.error(`[demo-real-block-run-fake] Error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});

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

const PROJECT_ROOT = resolve(process.cwd());
const CLI_PATH = join(PROJECT_ROOT, 'src', 'cli.ts');
const TSX_CLI_PATH = join(PROJECT_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');

const SAFE_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

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

function createBlockJson(blockPath: string, repoPath: string): string {
  const blockId = `demo-block-${Date.now()}`;
  const block = {
    block_id: blockId,
    title: 'Local fake block run demo',
    repo_path: repoPath.replace(/\\/g, '/'),
    base_branch: 'main',
    work_branch: 'ai-block-demo',
    providers: {
      coder: { provider: 'kimi', model: 'kimi-k2.6' },
      reviewer: { provider: 'kimi', model: 'kimi-k2.6' },
    },
    review_policy: {
      require_deterministic_checks: false,
      max_fix_attempts: 1,
      reviewer_mode: 'single',
    },
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
  writeFileSync(blockPath, JSON.stringify(block, null, 2), 'utf-8');
  return blockId;
}

function validateBlockId(blockId: string): void {
  if (!SAFE_ID_PATTERN.test(blockId)) {
    throw new Error(`Generated block_id is unsafe: ${blockId}`);
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
  const blockId = createBlockJson(blockPath, repoPath);
  validateBlockId(blockId);

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

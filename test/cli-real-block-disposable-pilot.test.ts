import { describe, test } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { runDisposablePilot, type CommandRunner } from '../src/real-block-disposable-pilot.js';

let counter = 0;

function getCleanEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.AI_PROVIDER;
  delete env.ALLOW_REAL_PROVIDER;
  delete env.REAL_BLOCK_RUN_AI;
  delete env.ALLOW_REAL_REPO_APPLY;
  delete env.ALLOW_REAL_REPO_COMMIT;
  delete env.ALLOW_REAL_REPO_PUSH;
  delete env.KIMI_FAKE_RESPONSE;
  delete env.KIMI_FAKE_RESPONSES;
  delete env.REAL_REPO_REVIEWER_FAKE_RESPONSE;
  delete env.REAL_REPO_REVIEWER_NO_DEFAULT;
  delete env.REAL_REPO_REVIEWER_FIX_TASK_FAKE_EXECUTOR_RESPONSE;
  delete env.REAL_REPO_ENABLE_REVIEWER_FIX_LOOP;
  return env;
}

function runCli(args: string[], envOverrides: Record<string, string> = {}) {
  const env = { ...getCleanEnv(), ...envOverrides };
  const quotedArgs = args.map((a) => (a.includes(' ') || a.includes('\\') ? `"${a}"` : a)).join(' ');
  const result = spawnSync(
    `npx tsx "${join(process.cwd(), 'src', 'cli.ts')}" ${quotedArgs}`,
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

function createTempProject(): { path: string; cleanup: () => void } {
  const id = `${Date.now()}-${counter++}`;
  const tmpBase = join(process.cwd(), 'tmp');
  if (!existsSync(tmpBase)) {
    mkdirSync(tmpBase);
  }
  const dir = mkdtempSync(join(tmpBase, `pilot-proj-${id}-`));
  return {
    path: dir,
    cleanup: () => {
      if (existsSync(dir)) {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  };
}

function createTempDir(prefix: string): { path: string; cleanup: () => void } {
  const id = `${Date.now()}-${counter++}`;
  const tmpBase = join(process.cwd(), 'tmp');
  if (!existsSync(tmpBase)) {
    mkdirSync(tmpBase);
  }
  const dir = mkdtempSync(join(tmpBase, `${prefix}-${id}-`));
  return {
    path: dir,
    cleanup: () => {
      if (existsSync(dir)) {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  };
}

function createTempRepo(): { path: string; cleanup: () => void } {
  const id = `${Date.now()}-${counter++}`;
  const tmpBase = join(process.cwd(), 'tmp');
  if (!existsSync(tmpBase)) {
    mkdirSync(tmpBase);
  }
  const dir = mkdtempSync(join(tmpBase, `pilot-repo-${id}-`));
  spawnSync('git', ['init'], { cwd: dir, encoding: 'utf-8', shell: false });
  spawnSync('git', ['checkout', '-b', 'main'], { cwd: dir, encoding: 'utf-8', shell: false });
  writeFileSync(join(dir, 'README.md'), '# hello\n', 'utf-8');
  spawnSync('git', ['add', '.'], { cwd: dir, encoding: 'utf-8', shell: false });
  spawnSync('git', ['commit', '-m', 'init'], { cwd: dir, encoding: 'utf-8', shell: false });
  return {
    path: dir,
    cleanup: () => {
      if (existsSync(dir)) {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  };
}

function initGitRepo(dir: string): void {
  spawnSync('git', ['init'], { cwd: dir, encoding: 'utf-8', shell: false });
  spawnSync('git', ['checkout', '-b', 'main'], { cwd: dir, encoding: 'utf-8', shell: false });
  writeFileSync(join(dir, 'initial.txt'), 'initial\n', 'utf-8');
  writeFileSync(join(dir, '.gitignore'), 'runs/\n', 'utf-8');
  spawnSync('git', ['add', '.'], { cwd: dir, encoding: 'utf-8', shell: false });
  spawnSync('git', ['commit', '-m', 'init'], { cwd: dir, encoding: 'utf-8', shell: false });
}

function commitBlockFile(projectRoot: string, blockPath: string): void {
  spawnSync('git', ['add', blockPath], { cwd: projectRoot, encoding: 'utf-8', shell: false });
  spawnSync('git', ['commit', '-m', 'add block file'], { cwd: projectRoot, encoding: 'utf-8', shell: false });
}

function buildBlockFile(opts: {
  blockPath: string;
  repoPath?: string;
  workBranch?: string;
  baseBranch?: string;
  tasks?: Array<{ task_id: string; status?: string }>;
}): { blockId: string } {
  const blockId = `block-${counter++}`;
  const block = {
    block_id: blockId,
    title: 'Disposable pilot test block',
    repo_path: opts.repoPath ?? createTempRepo().path,
    base_branch: opts.baseBranch ?? 'main',
    work_branch: opts.workBranch ?? 'ai-test-branch',
    providers: {
      coder: { provider: 'kimi', model: 'kimi-k2.6' },
      reviewer: { provider: 'kimi', model: 'kimi-k2.6' },
    },
    review_policy: { require_deterministic_checks: true, max_fix_attempts: 1, reviewer_mode: 'single' },
    tasks: opts.tasks ?? [{ task_id: 'task_1', status: 'pending' }],
  };
  writeFileSync(opts.blockPath, JSON.stringify(block, null, 2), 'utf-8');
  return { blockId };
}

function makeMockRunner(
  overrides: Partial<{
    preflight: { ok: boolean };
    probes: Record<string, { ok: boolean; decision?: string }>;
    runExitCode: number;
    reportExitCode: number;
    stateFile?: string;
  }> = {}
): CommandRunner {
  return async (args, _env) => {
    const command = args[0];
    if (command === 'real-block-run-ai' && overrides.stateFile) {
      mkdirSync(dirname(overrides.stateFile), { recursive: true });
      writeFileSync(overrides.stateFile, JSON.stringify({ status: 'completed' }), 'utf-8');
      return { exitCode: overrides.runExitCode ?? 0, stdout: '', stderr: '' };
    }
    if (command === 'real-block-preflight') {
      return {
        exitCode: overrides.preflight?.ok === false ? 1 : 0,
        stdout: JSON.stringify({ ok: overrides.preflight?.ok !== false }),
        stderr: '',
      };
    }
    if (command === 'real-block-task-probe') {
      const taskId = args[args.indexOf('--task-id') + 1];
      const probe = overrides.probes?.[taskId] ?? { ok: true, decision: 'accepted' };
      return {
        exitCode: probe.ok ? 0 : 1,
        stdout: JSON.stringify({
          ok: probe.ok,
          reviewer: { decision: probe.decision ?? 'accepted' },
        }),
        stderr: '',
      };
    }
    if (command === 'real-block-run-ai') {
      return {
        exitCode: overrides.runExitCode ?? 0,
        stdout: '',
        stderr: '',
      };
    }
    if (command === 'real-block-run-ai-report') {
      return {
        exitCode: overrides.reportExitCode ?? 0,
        stdout: 'Report output',
        stderr: '',
      };
    }
    return { exitCode: 1, stdout: '', stderr: 'Unknown command' };
  };
}

describe('real-block-disposable-pilot CLI', () => {
  test('missing block path exits non-zero', () => {
    const result = runCli(['real-block-disposable-pilot'], {
      ALLOW_REAL_PROVIDER: 'true',
    });
    assert.notStrictEqual(result.status, 0, `Expected failure: ${result.stderr}`);
    assert(result.stderr.includes('block definition path is required'), `Should mention required path: ${result.stderr}`);
  });

  test('missing block file exits non-zero', () => {
    const result = runCli(['real-block-disposable-pilot', 'nonexistent-block.json'], {
      ALLOW_REAL_PROVIDER: 'true',
    });
    assert.notStrictEqual(result.status, 0, `Expected failure: ${result.stderr}`);
    const output = result.stdout + result.stderr;
    assert(output.includes('not found') || output.includes('Block definition file'), `Should mention missing file: ${output}`);
  });

  test('invalid JSON exits non-zero', () => {
    const tmp = createTempProject();
    const blockPath = join(tmp.path, 'block.json');
    writeFileSync(blockPath, 'not json', 'utf-8');
    try {
      const result = runCli(['real-block-disposable-pilot', blockPath], {
        ALLOW_REAL_PROVIDER: 'true',
      });
      assert.notStrictEqual(result.status, 0, `Expected failure: ${result.stderr}`);
      const output = result.stdout + result.stderr;
    assert(output.includes('JSON') || output.includes('object'), `Should mention JSON error: ${output}`);
    } finally {
      tmp.cleanup();
    }
  });

  test('repo_path equal to current project repo exits non-zero', () => {
    const tmp = createTempProject();
    const blockPath = join(tmp.path, 'block.json');
    buildBlockFile({ blockPath, repoPath: process.cwd() });
    try {
      const result = runCli(['real-block-disposable-pilot', blockPath], {
        ALLOW_REAL_PROVIDER: 'true',
      });
      assert.notStrictEqual(result.status, 0, `Expected failure: ${result.stderr}`);
      const output = result.stdout + result.stderr;
    assert(output.includes('must not be the current project repo'), `Should refuse project repo: ${output}`);
    } finally {
      tmp.cleanup();
    }
  });

  test('repo_path inside current project repo exits non-zero', () => {
    const tmp = createTempProject();
    const blockPath = join(tmp.path, 'block.json');
    buildBlockFile({ blockPath, repoPath: join(process.cwd(), 'tmp') });
    try {
      const result = runCli(['real-block-disposable-pilot', blockPath], {
        ALLOW_REAL_PROVIDER: 'true',
      });
      assert.notStrictEqual(result.status, 0, `Expected failure: ${result.stderr}`);
      const output = result.stdout + result.stderr;
    assert(output.includes('must not be inside the current project repo'), `Should refuse inside project repo: ${output}`);
    } finally {
      tmp.cleanup();
    }
  });

  test('work_branch main exits non-zero', () => {
    const tmp = createTempProject();
    const repo = createTempRepo();
    const blockPath = join(tmp.path, 'block.json');
    buildBlockFile({ blockPath, repoPath: repo.path, workBranch: 'main' });
    try {
      const result = runCli(['real-block-disposable-pilot', blockPath], {
        ALLOW_REAL_PROVIDER: 'true',
      });
      assert.notStrictEqual(result.status, 0, `Expected failure: ${result.stderr}`);
      const output = result.stdout + result.stderr;
    assert(output.includes('work_branch must not be main or master'), `Should refuse main: ${output}`);
    } finally {
      tmp.cleanup();
      repo.cleanup();
    }
  });

  test('work_branch master exits non-zero', () => {
    const tmp = createTempProject();
    const repo = createTempRepo();
    const blockPath = join(tmp.path, 'block.json');
    buildBlockFile({ blockPath, repoPath: repo.path, workBranch: 'master' });
    try {
      const result = runCli(['real-block-disposable-pilot', blockPath], {
        ALLOW_REAL_PROVIDER: 'true',
      });
      assert.notStrictEqual(result.status, 0, `Expected failure: ${result.stderr}`);
      const output = result.stdout + result.stderr;
      assert(output.includes('work_branch must not be main or master'), `Should refuse master: ${output}`);
    } finally {
      tmp.cleanup();
      repo.cleanup();
    }
  });

  test('missing ALLOW_REAL_PROVIDER exits non-zero before any step', () => {
    const tmp = createTempProject();
    const repo = createTempRepo();
    const blockPath = join(tmp.path, 'block.json');
    const { blockId } = buildBlockFile({ blockPath, repoPath: repo.path });
    commitBlockFile(tmp.path, blockPath);
    try {
      const result = runCli(['real-block-disposable-pilot', blockPath], {});
      assert.notStrictEqual(result.status, 0, `Expected failure: ${result.stderr}`);
      const output = result.stdout + result.stderr;
    assert(output.includes('ALLOW_REAL_PROVIDER'), `Should require ALLOW_REAL_PROVIDER: ${output}`);
    } finally {
      tmp.cleanup();
      repo.cleanup();
    }
  });

  test('ALLOW_REAL_PROVIDER=false exits non-zero', () => {
    const tmp = createTempProject();
    const repo = createTempRepo();
    const blockPath = join(tmp.path, 'block.json');
    const { blockId } = buildBlockFile({ blockPath, repoPath: repo.path });
    commitBlockFile(tmp.path, blockPath);
    try {
      const result = runCli(['real-block-disposable-pilot', blockPath], {
        ALLOW_REAL_PROVIDER: 'false',
      });
      assert.notStrictEqual(result.status, 0, `Expected failure: ${result.stderr}`);
      const output = result.stdout + result.stderr;
    assert(output.includes('ALLOW_REAL_PROVIDER'), `Should require ALLOW_REAL_PROVIDER: ${output}`);
    } finally {
      tmp.cleanup();
      repo.cleanup();
    }
  });
});

describe('real-block-disposable-pilot helper', () => {
  test('missing repo_path exits non-zero', async () => {
    const tmp = createTempProject();
    const blockPath = join(tmp.path, 'block.json');
    const block = {
      block_id: 'block-missing-repo',
      title: 'test',
      base_branch: 'main',
      work_branch: 'ai-test',
      tasks: [{ task_id: 'task_1', status: 'pending' }],
    };
    writeFileSync(blockPath, JSON.stringify(block), 'utf-8');
    try {
      const result = await runDisposablePilot({
        blockPath,
        provider: 'kimi',
        timeoutMs: 120000,
        projectRoot: tmp.path,
        env: { ALLOW_REAL_PROVIDER: 'true' },
        runCommand: makeMockRunner(),
      });
      assert.strictEqual(result.ok, false);
      assert(result.error?.includes('repo_path'), `Should mention repo_path: ${result.error}`);
    } finally {
      tmp.cleanup();
    }
  });

  test('preflight failure stops before task probe/run', async () => {
    const tmp = createTempProject();
    initGitRepo(tmp.path);
    const repo = createTempRepo();
    const blockPath = join(tmp.path, 'block.json');
    const { blockId } = buildBlockFile({ blockPath, repoPath: repo.path });
    commitBlockFile(tmp.path, blockPath);
    const calls: string[] = [];
    const runner: CommandRunner = async (args) => {
      calls.push(args[0]);
      return { exitCode: 1, stdout: JSON.stringify({ ok: false }), stderr: '' };
    };
    try {
      const result = await runDisposablePilot({
        blockPath,
        provider: 'kimi',
        timeoutMs: 120000,
        projectRoot: tmp.path,
        env: { ALLOW_REAL_PROVIDER: 'true' },
        runCommand: runner,
      });
      assert.strictEqual(result.ok, false);
      assert.strictEqual(result.preflight?.ok, false);
      assert.deepStrictEqual(calls, ['real-block-preflight']);
      assert(result.error?.includes('Preflight failed'), `Should mention preflight: ${result.error}`);
    } finally {
      tmp.cleanup();
      repo.cleanup();
    }
  });

  test('task probe failure stops before real run', async () => {
    const tmp = createTempProject();
    initGitRepo(tmp.path);
    const repo = createTempRepo();
    const blockPath = join(tmp.path, 'block.json');
    const { blockId } = buildBlockFile({ blockPath, repoPath: repo.path });
    commitBlockFile(tmp.path, blockPath);
    const calls: string[] = [];
    const runner = makeMockRunner({ probes: { task_1: { ok: false, decision: 'rejected' } } });
    const trackingRunner: CommandRunner = async (args, env) => {
      calls.push(args[0]);
      return runner(args, env);
    };
    try {
      const result = await runDisposablePilot({
        blockPath,
        provider: 'kimi',
        timeoutMs: 120000,
        projectRoot: tmp.path,
        env: { ALLOW_REAL_PROVIDER: 'true' },
        runCommand: trackingRunner,
      });
      assert.strictEqual(result.ok, false);
      assert(result.preflight?.ok, true);
      assert(result.taskProbes?.length, 1);
      assert.strictEqual(result.taskProbes?.[0].ok, false);
      assert(!calls.includes('real-block-run-ai'), `Should not run real-block-run-ai: ${calls.join(', ')}`);
    } finally {
      tmp.cleanup();
      repo.cleanup();
    }
  });

  test('missing mutation opt-ins stops before run', async () => {
    const tmp = createTempProject();
    initGitRepo(tmp.path);
    const repo = createTempRepo();
    const blockPath = join(tmp.path, 'block.json');
    const { blockId } = buildBlockFile({ blockPath, repoPath: repo.path });
    commitBlockFile(tmp.path, blockPath);
    const calls: string[] = [];
    const stateFile = join(tmp.path, 'runs', 'block', blockId, 'state.json');
    const runner = makeMockRunner({ stateFile });
    const trackingRunner: CommandRunner = async (args, env) => {
      calls.push(args[0]);
      return runner(args, env);
    };
    try {
      const result = await runDisposablePilot({
        blockPath,
        provider: 'kimi',
        timeoutMs: 120000,
        projectRoot: tmp.path,
        env: { ALLOW_REAL_PROVIDER: 'true' },
        runCommand: trackingRunner,
      });
      assert.strictEqual(result.ok, false);
      assert(result.preflight?.ok, true);
      assert.strictEqual(result.taskProbes?.[0].ok, true);
      assert(!calls.includes('real-block-run-ai'), `Should not run real-block-run-ai: ${calls.join(', ')}`);
      assert(result.error?.includes('Mutation opt-ins required'), `Should mention opt-ins: ${result.error}`);
    } finally {
      tmp.cleanup();
      repo.cleanup();
    }
  });

  test('successful mocked flow runs preflight probe run report', async () => {
    const tmp = createTempProject();
    initGitRepo(tmp.path);
    const repo = createTempRepo();
    const blockPath = join(tmp.path, 'block.json');
    const { blockId } = buildBlockFile({ blockPath, repoPath: repo.path });
    commitBlockFile(tmp.path, blockPath);
    const calls: string[] = [];
    const stateFile = join(tmp.path, 'runs', 'block', blockId, 'state.json');
    const runner = makeMockRunner({ stateFile });
    const trackingRunner: CommandRunner = async (args, env) => {
      calls.push(args[0]);
      return runner(args, env);
    };
    try {
      const result = await runDisposablePilot({
        blockPath,
        provider: 'kimi',
        timeoutMs: 120000,
        projectRoot: tmp.path,
        env: {
          ALLOW_REAL_PROVIDER: 'true',
          REAL_BLOCK_RUN_AI: '1',
          ALLOW_REAL_REPO_APPLY: 'true',
          ALLOW_REAL_REPO_COMMIT: 'true',
          ALLOW_REAL_REPO_PUSH: 'true',
        },
        runCommand: trackingRunner,
      });
      assert.strictEqual(result.ok, true, `Expected ok: ${result.error}`);
      assert(result.preflight?.ok, true);
      assert.strictEqual(result.taskProbes?.length, 1);
      assert.strictEqual(result.taskProbes?.[0].ok, true);
      assert.strictEqual(result.taskProbes?.[0].reviewerDecision, 'accepted');
      assert.strictEqual(result.run?.exitCode, 0);
      assert.strictEqual(result.report?.exitCode, 0);
      assert(calls.includes('real-block-preflight'));
      assert(calls.includes('real-block-task-probe'));
      assert(calls.includes('real-block-run-ai'));
      assert(calls.includes('real-block-run-ai-report'));
      assert(result.safety?.projectRepoClean, true);
      assert.strictEqual(result.safety?.workflowChanged, false);
      assert.strictEqual(result.safety?.mainMergePerformed, false);
      assert.strictEqual(result.safety?.tokenLeakDetected, false);
    } finally {
      tmp.cleanup();
      repo.cleanup();
    }
  });

  test('multi-task block probes every pending task', async () => {
    const tmp = createTempProject();
    initGitRepo(tmp.path);
    const repo = createTempRepo();
    const blockPath = join(tmp.path, 'block.json');
    const { blockId } = buildBlockFile({
      blockPath,
      repoPath: repo.path,
      tasks: [
        { task_id: 'task_1', status: 'pending' },
        { task_id: 'task_2', status: 'pending' },
        { task_id: 'task_3', status: 'accepted' },
      ],
    });
    commitBlockFile(tmp.path, blockPath);
    const probes: string[] = [];
    const stateFile = join(tmp.path, 'runs', 'block', blockId, 'state.json');
    const runner = makeMockRunner({ stateFile });
    const trackingRunner: CommandRunner = async (args, env) => {
      if (args[0] === 'real-block-task-probe') {
        probes.push(args[args.indexOf('--task-id') + 1]);
      }
      return runner(args, env);
    };
    try {
      const result = await runDisposablePilot({
        blockPath,
        provider: 'kimi',
        timeoutMs: 120000,
        projectRoot: tmp.path,
        env: {
          ALLOW_REAL_PROVIDER: 'true',
          REAL_BLOCK_RUN_AI: '1',
          ALLOW_REAL_REPO_APPLY: 'true',
          ALLOW_REAL_REPO_COMMIT: 'true',
          ALLOW_REAL_REPO_PUSH: 'true',
        },
        runCommand: trackingRunner,
      });
      assert.strictEqual(result.ok, true);
      assert.deepStrictEqual(probes.sort(), ['task_1', 'task_2']);
      assert.strictEqual(result.taskProbes?.length, 2);
    } finally {
      tmp.cleanup();
      repo.cleanup();
    }
  });

  test('non-pending tasks are reported as skipped', async () => {
    const tmp = createTempProject();
    initGitRepo(tmp.path);
    const repo = createTempRepo();
    const blockPath = join(tmp.path, 'block.json');
    buildBlockFile({
      blockPath,
      repoPath: repo.path,
      tasks: [{ task_id: 'task_1', status: 'accepted' }],
    });
    try {
      const result = await runDisposablePilot({
        blockPath,
        provider: 'kimi',
        timeoutMs: 120000,
        projectRoot: tmp.path,
        env: { ALLOW_REAL_PROVIDER: 'true' },
        runCommand: makeMockRunner(),
      });
      assert.strictEqual(result.ok, false);
      assert.strictEqual(result.taskProbes?.length, 0);
      assert(result.error?.includes('No pending tasks'), `Should mention no pending tasks: ${result.error}`);
    } finally {
      tmp.cleanup();
      repo.cleanup();
    }
  });

  test('final summary redacts secrets', async () => {
    const tmp = createTempProject();
    initGitRepo(tmp.path);
    const repo = createTempRepo();
    const blockPath = join(tmp.path, 'block.json');
    const { blockId } = buildBlockFile({ blockPath, repoPath: repo.path });
    commitBlockFile(tmp.path, blockPath);
    const runner: CommandRunner = async (args) => {
      if (args[0] === 'real-block-task-probe') {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            ok: true,
            reviewer: { decision: 'accepted' },
            leaked: 'sk-live-secret-token and Bearer live-token and pk-public',
          }),
          stderr: '',
        };
      }
      const base = makeMockRunner({ stateFile: join(tmp.path, 'runs', 'block', blockId, 'state.json') });
      return base(args, {} as NodeJS.ProcessEnv);
    };
    try {
      const result = await runDisposablePilot({
        blockPath,
        provider: 'kimi',
        timeoutMs: 120000,
        projectRoot: tmp.path,
        env: {
          ALLOW_REAL_PROVIDER: 'true',
          REAL_BLOCK_RUN_AI: '1',
          ALLOW_REAL_REPO_APPLY: 'true',
          ALLOW_REAL_REPO_COMMIT: 'true',
          ALLOW_REAL_REPO_PUSH: 'true',
        },
        runCommand: runner,
      });
      const raw = JSON.stringify(result);
      assert(!raw.includes('sk-live-secret-token'), `Should redact sk token: ${raw}`);
      assert(!raw.includes('Bearer live-token'), `Should redact Bearer token: ${raw}`);
      assert(!raw.includes('pk-public'), `Should redact pk token: ${raw}`);
      assert(raw.includes('[REDACTED]'), `Should contain [REDACTED]: ${raw}`);
    } finally {
      tmp.cleanup();
      repo.cleanup();
    }
  });

  test('project repo dirty after run fails safely', async () => {
    const tmp = createTempProject();
    initGitRepo(tmp.path);
    const repo = createTempRepo();
    const blockPath = join(tmp.path, 'block.json');
    const { blockId } = buildBlockFile({ blockPath, repoPath: repo.path });
    commitBlockFile(tmp.path, blockPath);
    const stateFile = join(tmp.path, 'runs', 'block', blockId, 'state.json');
    const runner = makeMockRunner({ stateFile });
    const dirtyRunner: CommandRunner = async (args, env) => {
      if (args[0] === 'real-block-run-ai') {
        writeFileSync(join(tmp.path, 'dirty-file.txt'), 'dirty\n', 'utf-8');
      }
      return runner(args, env);
    };
    try {
      const result = await runDisposablePilot({
        blockPath,
        provider: 'kimi',
        timeoutMs: 120000,
        projectRoot: tmp.path,
        env: {
          ALLOW_REAL_PROVIDER: 'true',
          REAL_BLOCK_RUN_AI: '1',
          ALLOW_REAL_REPO_APPLY: 'true',
          ALLOW_REAL_REPO_COMMIT: 'true',
          ALLOW_REAL_REPO_PUSH: 'true',
        },
        runCommand: dirtyRunner,
      });
      assert.strictEqual(result.ok, false);
      assert.strictEqual(result.safety?.projectRepoClean, false);
      assert(result.error?.includes('safety'), `Should mention safety: ${result.error}`);
    } finally {
      tmp.cleanup();
      repo.cleanup();
    }
  });

  test('github workflows diff after run fails safely', async () => {
    const tmp = createTempProject();
    initGitRepo(tmp.path);
    mkdirSync(join(tmp.path, '.github', 'workflows'), { recursive: true });
    writeFileSync(join(tmp.path, '.github', 'workflows', 'ci.yml'), 'name: ci\n', 'utf-8');
    spawnSync('git', ['add', '.'], { cwd: tmp.path, encoding: 'utf-8', shell: false });
    spawnSync('git', ['commit', '-m', 'add workflow'], { cwd: tmp.path, encoding: 'utf-8', shell: false });
    const repo = createTempRepo();
    const blockPath = join(tmp.path, 'block.json');
    const { blockId } = buildBlockFile({ blockPath, repoPath: repo.path });
    commitBlockFile(tmp.path, blockPath);
    const stateFile = join(tmp.path, 'runs', 'block', blockId, 'state.json');
    const runner = makeMockRunner({ stateFile });
    const dirtyRunner: CommandRunner = async (args, env) => {
      if (args[0] === 'real-block-run-ai') {
        const wfPath = join(tmp.path, '.github', 'workflows', 'ci.yml');
        writeFileSync(wfPath, 'name: modified\n', 'utf-8');
      }
      return runner(args, env);
    };
    try {
      const result = await runDisposablePilot({
        blockPath,
        provider: 'kimi',
        timeoutMs: 120000,
        projectRoot: tmp.path,
        env: {
          ALLOW_REAL_PROVIDER: 'true',
          REAL_BLOCK_RUN_AI: '1',
          ALLOW_REAL_REPO_APPLY: 'true',
          ALLOW_REAL_REPO_COMMIT: 'true',
          ALLOW_REAL_REPO_PUSH: 'true',
        },
        runCommand: dirtyRunner,
      });
      assert.strictEqual(result.ok, false);
      assert.strictEqual(result.safety?.workflowChanged, true);
    } finally {
      tmp.cleanup();
      repo.cleanup();
    }
  });

  test('command runner receives no live network env', async () => {
    const tmp = createTempProject();
    initGitRepo(tmp.path);
    const repo = createTempRepo();
    const blockPath = join(tmp.path, 'block.json');
    const { blockId } = buildBlockFile({ blockPath, repoPath: repo.path });
    commitBlockFile(tmp.path, blockPath);
    let capturedEnv: NodeJS.ProcessEnv | undefined;
    const runner: CommandRunner = async (args, env) => {
      if (args[0] === 'real-block-run-ai') {
        capturedEnv = env;
      }
      const base = makeMockRunner({ stateFile: join(tmp.path, 'runs', 'block', blockId, 'state.json') });
      return base(args, env);
    };
    try {
      await runDisposablePilot({
        blockPath,
        provider: 'kimi',
        timeoutMs: 120000,
        projectRoot: tmp.path,
        env: {
          ALLOW_REAL_PROVIDER: 'true',
          REAL_BLOCK_RUN_AI: '1',
          ALLOW_REAL_REPO_APPLY: 'true',
          ALLOW_REAL_REPO_COMMIT: 'true',
          ALLOW_REAL_REPO_PUSH: 'true',
        },
        runCommand: runner,
      });
      assert(capturedEnv);
      assert.strictEqual(capturedEnv!.KIMI_FAKE_RESPONSE, undefined);
      assert.strictEqual(capturedEnv!.REAL_REPO_REVIEWER_FAKE_RESPONSE, undefined);
    } finally {
      tmp.cleanup();
      repo.cleanup();
    }
  });
});

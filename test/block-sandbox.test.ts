import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { writeFileSync, readFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join, resolve, normalize } from 'node:path';
import { tmpdir } from 'node:os';
import { runBlockSandbox, validateSandboxPath } from '../src/block/block-sandbox.js';
import { getBlockRunDir } from '../src/block/block-state-manager.js';
import type { BlockDefinition } from '../src/block/block-types.js';

describe('block-sandbox', () => {
  let blockJsonPath: string;
  let blockId: string;
  let repoPath: string;
  const originalEnv = { ...process.env };

  function makeDefinition(): BlockDefinition {
    return {
      block_id: blockId,
      title: 'Sandbox Test Block',
      repo_path: repoPath,
      base_branch: 'main',
      work_branch: 'sandbox-test',
      providers: {
        coder: { provider: 'fake', model: 'default' },
        reviewer: { provider: 'fake', model: 'default' },
      },
      review_policy: {
        require_deterministic_checks: true,
        max_fix_attempts: 2,
        reviewer_mode: 'single',
      },
      tasks: [
        {
          task_id: 'task-1',
          title: 'T1',
          goal: 'G1',
          allowed_files: ['a.txt'],
          denied_files: [],
          max_lines_changed: 50,
          checks: [],
        },
      ],
    };
  }

  function createFakeRunCommand(
    scenarios: Record<string, { status: number; stdout: string; stderr: string }>
  ) {
    return (cwd: string, command: string, args: string[]) => {
      const key = `${command} ${args.join(' ')}`;
      const match = scenarios[key];
      if (match) {
        return { ...match };
      }
      // Default success for git status
      if (command === 'git' && args[0] === 'status' && args[1] === '--porcelain') {
        return { status: 0, stdout: '', stderr: '' };
      }
      // Default success for git rev-parse
      if (command === 'git' && args[0] === 'rev-parse') {
        return { status: 0, stdout: 'abc123def456abc123def456abc123def456abcd\n', stderr: '' };
      }
      // Default success for git worktree
      if (command === 'git' && args[0] === 'worktree') {
        return { status: 0, stdout: '', stderr: '' };
      }
      return { status: 0, stdout: '', stderr: '' };
    };
  }

  beforeEach(() => {
    blockId = `sandbox-${Date.now()}`;
    repoPath = join(tmpdir(), `repo-${blockId}`);
    mkdirSync(repoPath, { recursive: true });
    blockJsonPath = join(tmpdir(), `block-${blockId}.json`);
    process.env.ALLOW_BLOCK_SANDBOX = 'true';
  });

  afterEach(() => {
    process.env = originalEnv;
    try {
      if (existsSync(blockJsonPath)) {
        rmSync(blockJsonPath, { force: true });
      }
      const runDir = getBlockRunDir(blockId);
      if (existsSync(runDir)) {
        rmSync(runDir, { recursive: true, force: true });
      }
      if (existsSync(repoPath)) {
        rmSync(repoPath, { recursive: true, force: true });
      }
    } catch {
      // ignore cleanup errors
    }
  });

  it('missing ALLOW_BLOCK_SANDBOX blocks', () => {
    delete process.env.ALLOW_BLOCK_SANDBOX;
    const def = makeDefinition();
    writeFileSync(blockJsonPath, JSON.stringify(def, null, 2));

    assert.throws(
      () => runBlockSandbox({ blockDefinitionPath: blockJsonPath }),
      /ALLOW_BLOCK_SANDBOX/
    );
  });

  it('dirty main working tree blocks', () => {
    const def = makeDefinition();
    writeFileSync(blockJsonPath, JSON.stringify(def, null, 2));

    const run = createFakeRunCommand({
      'git status --porcelain': { status: 0, stdout: 'M file.txt\n', stderr: '' },
    });

    assert.throws(
      () => runBlockSandbox({ blockDefinitionPath: blockJsonPath, runCommand: run }),
      /not clean/
    );
  });

  it('creates worktree with expected path and runs checks', () => {
    const def = makeDefinition();
    writeFileSync(blockJsonPath, JSON.stringify(def, null, 2));

    const commands: string[] = [];
    const run = (cwd: string, command: string, args: string[]) => {
      const key = `${command} ${args.join(' ')}`;
      commands.push(`${cwd}:${key}`);
      if (command === 'git' && args[0] === 'status' && args[1] === '--porcelain') {
        return { status: 0, stdout: '', stderr: '' };
      }
      if (command === 'git' && args[0] === 'rev-parse') {
        return { status: 0, stdout: 'main-commit-sha\n', stderr: '' };
      }
      if (command === 'git' && args[0] === 'worktree' && args[1] === 'add') {
        return { status: 0, stdout: '', stderr: '' };
      }
      if (command === 'npm') {
        return { status: 0, stdout: 'ok', stderr: '' };
      }
      return { status: 0, stdout: '', stderr: '' };
    };

    const result = runBlockSandbox({ blockDefinitionPath: blockJsonPath, runCommand: run });

    assert.strictEqual(result.block_id, blockId);
    assert.ok(normalize(result.sandbox_path).includes(normalize('tmp/block-sandbox')));
    assert.strictEqual(result.typecheck_result, 'pass');
    assert.strictEqual(result.build_result, 'pass');
    assert.strictEqual(result.test_result, 'pass');
    assert.ok(commands.some((c) => c.includes('git worktree add')));
    assert.ok(commands.some((c) => c.includes('npm run typecheck')));
    assert.ok(commands.some((c) => c.includes('npm run build')));
    assert.ok(commands.some((c) => c.includes('npm test')));
  });

  it('cleanup removes worktree by default', () => {
    const def = makeDefinition();
    writeFileSync(blockJsonPath, JSON.stringify(def, null, 2));

    const commands: string[] = [];
    const run = (cwd: string, command: string, args: string[]) => {
      const key = `${command} ${args.join(' ')}`;
      commands.push(key);
      if (command === 'git' && args[0] === 'status' && args[1] === '--porcelain') {
        return { status: 0, stdout: '', stderr: '' };
      }
      if (command === 'git' && args[0] === 'rev-parse') {
        return { status: 0, stdout: 'main-commit-sha\n', stderr: '' };
      }
      if (command === 'git' && args[0] === 'worktree' && args[1] === 'list') {
        return { status: 0, stdout: `worktree ${resolve(join(process.cwd(), 'tmp', 'block-sandbox', blockId))}\nHEAD abc123\n`, stderr: '' };
      }
      if (command === 'git' && args[0] === 'worktree') {
        return { status: 0, stdout: '', stderr: '' };
      }
      if (command === 'npm') {
        return { status: 0, stdout: 'ok', stderr: '' };
      }
      return { status: 0, stdout: '', stderr: '' };
    };

    const result = runBlockSandbox({ blockDefinitionPath: blockJsonPath, runCommand: run });

    assert.strictEqual(result.cleanup_result, 'success');
    assert.ok(commands.some((c) => c.startsWith('git worktree remove')));
  });

  it('keep flag does not remove worktree', () => {
    const def = makeDefinition();
    writeFileSync(blockJsonPath, JSON.stringify(def, null, 2));

    const commands: string[] = [];
    const run = (cwd: string, command: string, args: string[]) => {
      const key = `${command} ${args.join(' ')}`;
      commands.push(key);
      if (command === 'git' && args[0] === 'status' && args[1] === '--porcelain') {
        return { status: 0, stdout: '', stderr: '' };
      }
      if (command === 'git' && args[0] === 'rev-parse') {
        return { status: 0, stdout: 'main-commit-sha\n', stderr: '' };
      }
      if (command === 'git' && args[0] === 'worktree') {
        return { status: 0, stdout: '', stderr: '' };
      }
      if (command === 'npm') {
        return { status: 0, stdout: 'ok', stderr: '' };
      }
      return { status: 0, stdout: '', stderr: '' };
    };

    const result = runBlockSandbox({ blockDefinitionPath: blockJsonPath, runCommand: run, keep: true });

    assert.strictEqual(result.cleanup_result, 'skipped');
    assert.ok(!commands.includes('git worktree remove'));
  });

  it('custom sandbox path works', () => {
    const def = makeDefinition();
    writeFileSync(blockJsonPath, JSON.stringify(def, null, 2));

    const customPath = join(tmpdir(), `custom-sandbox-${blockId}`);
    const run = createFakeRunCommand({
      'git worktree add': { status: 0, stdout: '', stderr: '' },
      'npm run typecheck': { status: 0, stdout: 'ok', stderr: '' },
      'npm run build': { status: 0, stdout: 'ok', stderr: '' },
      'npm test': { status: 0, stdout: 'ok', stderr: '' },
      'git worktree remove': { status: 0, stdout: '', stderr: '' },
    });

    const result = runBlockSandbox({
      blockDefinitionPath: blockJsonPath,
      runCommand: run,
      sandboxPath: customPath,
    });

    assert.strictEqual(result.sandbox_path, resolve(customPath));
  });

  it('custom base ref works', () => {
    const def = makeDefinition();
    writeFileSync(blockJsonPath, JSON.stringify(def, null, 2));

    const run = createFakeRunCommand({
      'git worktree add': { status: 0, stdout: '', stderr: '' },
      'npm run typecheck': { status: 0, stdout: 'ok', stderr: '' },
      'npm run build': { status: 0, stdout: 'ok', stderr: '' },
      'npm test': { status: 0, stdout: 'ok', stderr: '' },
      'git worktree remove': { status: 0, stdout: '', stderr: '' },
    });

    const result = runBlockSandbox({
      blockDefinitionPath: blockJsonPath,
      runCommand: run,
      baseRef: 'feature/custom',
    });

    assert.strictEqual(result.base_branch, 'feature/custom');
  });

  it('failed command marks report as failed', () => {
    const def = makeDefinition();
    writeFileSync(blockJsonPath, JSON.stringify(def, null, 2));

    const run = createFakeRunCommand({
      'git worktree add': { status: 0, stdout: '', stderr: '' },
      'npm run typecheck': { status: 1, stdout: '', stderr: 'type error' },
      'npm run build': { status: 0, stdout: 'ok', stderr: '' },
      'npm test': { status: 0, stdout: 'ok', stderr: '' },
      'git worktree remove': { status: 0, stdout: '', stderr: '' },
    });

    const result = runBlockSandbox({
      blockDefinitionPath: blockJsonPath,
      runCommand: run,
    });

    assert.strictEqual(result.typecheck_result, 'fail');
    assert.strictEqual(result.build_result, 'pass');
    assert.strictEqual(result.test_result, 'pass');
    assert.ok(result.blocking_issues.includes('typecheck failed'));
  });

  it('token-like values are redacted from report', () => {
    const def = makeDefinition();
    writeFileSync(blockJsonPath, JSON.stringify(def, null, 2));

    const run = createFakeRunCommand({
      'git worktree add': { status: 0, stdout: '', stderr: '' },
      'npm run typecheck': { status: 0, stdout: 'ok ghp_1234567890abcdef1234567890abcdef1234', stderr: '' },
      'npm run build': { status: 0, stdout: 'ok', stderr: '' },
      'npm test': { status: 0, stdout: 'ok', stderr: '' },
      'git worktree remove': { status: 0, stdout: '', stderr: '' },
    });

    const result = runBlockSandbox({
      blockDefinitionPath: blockJsonPath,
      runCommand: run,
    });

    const report = readFileSync(result.output_path, 'utf-8');
    assert.ok(!report.includes('ghp_1234567890abcdef1234567890abcdef1234'));
    assert.ok(report.includes('[REDACTED]'));
  });

  it('main working tree remains untouched', () => {
    const def = makeDefinition();
    writeFileSync(blockJsonPath, JSON.stringify(def, null, 2));

    const run = createFakeRunCommand({
      'git status --porcelain': { status: 0, stdout: '', stderr: '' },
      'git worktree add': { status: 0, stdout: '', stderr: '' },
      'npm run typecheck': { status: 0, stdout: 'ok', stderr: '' },
      'npm run build': { status: 0, stdout: 'ok', stderr: '' },
      'npm test': { status: 0, stdout: 'ok', stderr: '' },
      'git worktree remove': { status: 0, stdout: '', stderr: '' },
    });

    const result = runBlockSandbox({
      blockDefinitionPath: blockJsonPath,
      runCommand: run,
    });

    assert.strictEqual(result.main_status_before, 'clean');
    assert.strictEqual(result.main_status_after, 'clean');
    assert.strictEqual(result.safety_findings.length, 0);
  });

  it('report is written inside runs directory', () => {
    const def = makeDefinition();
    writeFileSync(blockJsonPath, JSON.stringify(def, null, 2));

    const run = createFakeRunCommand({
      'git worktree add': { status: 0, stdout: '', stderr: '' },
      'npm run typecheck': { status: 0, stdout: 'ok', stderr: '' },
      'npm run build': { status: 0, stdout: 'ok', stderr: '' },
      'npm test': { status: 0, stdout: 'ok', stderr: '' },
      'git worktree remove': { status: 0, stdout: '', stderr: '' },
    });

    const result = runBlockSandbox({
      blockDefinitionPath: blockJsonPath,
      runCommand: run,
    });

    assert.ok(result.output_path.includes('runs'));
    assert.ok(existsSync(result.output_path));
  });

  it('sandbox path inside repo is rejected', () => {
    const def = makeDefinition();
    writeFileSync(blockJsonPath, JSON.stringify(def, null, 2));

    const run = createFakeRunCommand({
      'git status --porcelain': { status: 0, stdout: '', stderr: '' },
    });

    assert.throws(
      () =>
        runBlockSandbox({
          blockDefinitionPath: blockJsonPath,
          runCommand: run,
          sandboxPath: join(repoPath, 'nested-sandbox'),
        }),
      /must not be inside/
    );
  });

  it('sandbox path equal to repo root is rejected', () => {
    const def = makeDefinition();
    writeFileSync(blockJsonPath, JSON.stringify(def, null, 2));

    const run = createFakeRunCommand({
      'git status --porcelain': { status: 0, stdout: '', stderr: '' },
    });

    assert.throws(
      () =>
        runBlockSandbox({
          blockDefinitionPath: blockJsonPath,
          runCommand: run,
          sandboxPath: repoPath,
        }),
      /must not be the repository root/
    );
  });

  it('sandbox path inside .git is rejected', () => {
    const def = makeDefinition();
    writeFileSync(blockJsonPath, JSON.stringify(def, null, 2));

    const run = createFakeRunCommand({
      'git status --porcelain': { status: 0, stdout: '', stderr: '' },
    });

    assert.throws(
      () =>
        runBlockSandbox({
          blockDefinitionPath: blockJsonPath,
          runCommand: run,
          sandboxPath: join(repoPath, '.git', 'worktrees', 'x'),
        }),
      /must not be inside \.git/
    );
  });

  it('sandbox path outside project directory is rejected without custom path', () => {
    const outsidePath = join(tmpdir(), 'outside-sandbox');
    const result = validateSandboxPath(outsidePath, repoPath, false);
    assert.strictEqual(result.ok, false);
    assert.ok(result.reason?.includes('must be inside the project directory'));
  });

  it('sandbox path outside project directory is allowed when explicitly provided', () => {
    const def = makeDefinition();
    writeFileSync(blockJsonPath, JSON.stringify(def, null, 2));

    const customPath = join(tmpdir(), 'explicit-sandbox');
    const run = createFakeRunCommand({
      'git worktree add': { status: 0, stdout: '', stderr: '' },
      'git worktree list --porcelain': { status: 0, stdout: `worktree ${resolve(customPath)}\nHEAD abc123\n`, stderr: '' },
      'npm run typecheck': { status: 0, stdout: 'ok', stderr: '' },
      'npm run build': { status: 0, stdout: 'ok', stderr: '' },
      'npm test': { status: 0, stdout: 'ok', stderr: '' },
      'git worktree remove': { status: 0, stdout: '', stderr: '' },
    });

    const result = runBlockSandbox({
      blockDefinitionPath: blockJsonPath,
      runCommand: run,
      sandboxPath: customPath,
    });

    assert.strictEqual(result.sandbox_path, resolve(customPath));
    assert.strictEqual(result.path_validation, 'pass');
  });

  it('cleanup refuses to remove unregistered worktree', () => {
    const def = makeDefinition();
    writeFileSync(blockJsonPath, JSON.stringify(def, null, 2));

    const run = createFakeRunCommand({
      'git worktree add': { status: 0, stdout: '', stderr: '' },
      'git worktree list --porcelain': { status: 0, stdout: '', stderr: '' },
      'npm run typecheck': { status: 0, stdout: 'ok', stderr: '' },
      'npm run build': { status: 0, stdout: 'ok', stderr: '' },
      'npm test': { status: 0, stdout: 'ok', stderr: '' },
    });

    const result = runBlockSandbox({
      blockDefinitionPath: blockJsonPath,
      runCommand: run,
    });

    assert.strictEqual(result.cleanup_result, 'failed');
  });

  it('cleanup verifies worktree no longer listed after remove', () => {
    const def = makeDefinition();
    writeFileSync(blockJsonPath, JSON.stringify(def, null, 2));

    let listCallCount = 0;
    const run = (cwd: string, command: string, args: string[]) => {
      const key = `${command} ${args.join(' ')}`;
      if (command === 'git' && args[0] === 'status' && args[1] === '--porcelain') {
        return { status: 0, stdout: '', stderr: '' };
      }
      if (command === 'git' && args[0] === 'rev-parse') {
        return { status: 0, stdout: 'abc123def456abc123def456abc123def456abcd\n', stderr: '' };
      }
      if (command === 'git' && args[0] === 'worktree' && args[1] === 'add') {
        return { status: 0, stdout: '', stderr: '' };
      }
      if (command === 'git' && args[0] === 'worktree' && args[1] === 'list') {
        listCallCount++;
        // Before remove: registered (calls 1 and 2); after remove: not registered (call 3)
        if (listCallCount <= 2) {
          return { status: 0, stdout: `worktree ${resolve(join(process.cwd(), 'tmp', 'block-sandbox', blockId))}\nHEAD abc123\n`, stderr: '' };
        }
        return { status: 0, stdout: '', stderr: '' };
      }
      if (command === 'git' && args[0] === 'worktree' && args[1] === 'remove') {
        return { status: 0, stdout: '', stderr: '' };
      }
      if (command === 'npm') {
        return { status: 0, stdout: 'ok', stderr: '' };
      }
      return { status: 0, stdout: '', stderr: '' };
    };

    const result = runBlockSandbox({
      blockDefinitionPath: blockJsonPath,
      runCommand: run,
    });

    assert.strictEqual(result.cleanup_result, 'success');
    assert.strictEqual(result.cleanup_verified, true);
  });

  it('main HEAD change is detected as blocking issue', () => {
    const def = makeDefinition();
    writeFileSync(blockJsonPath, JSON.stringify(def, null, 2));

    let revParseCount = 0;
    const run = (cwd: string, command: string, args: string[]) => {
      if (command === 'git' && args[0] === 'status' && args[1] === '--porcelain') {
        return { status: 0, stdout: '', stderr: '' };
      }
      if (command === 'git' && args[0] === 'rev-parse') {
        revParseCount++;
        if (revParseCount <= 3) {
          return { status: 0, stdout: 'before-sha\n', stderr: '' };
        }
        return { status: 0, stdout: 'after-sha\n', stderr: '' };
      }
      if (command === 'git' && args[0] === 'worktree' && args[1] === 'add') {
        return { status: 0, stdout: '', stderr: '' };
      }
      if (command === 'git' && args[0] === 'worktree' && args[1] === 'list') {
        return { status: 0, stdout: '', stderr: '' };
      }
      if (command === 'git' && args[0] === 'worktree' && args[1] === 'remove') {
        return { status: 0, stdout: '', stderr: '' };
      }
      if (command === 'npm') {
        return { status: 0, stdout: 'ok', stderr: '' };
      }
      return { status: 0, stdout: '', stderr: '' };
    };

    const result = runBlockSandbox({
      blockDefinitionPath: blockJsonPath,
      runCommand: run,
    });

    assert.strictEqual(result.main_head_before, 'before-sha');
    assert.strictEqual(result.main_head_after, 'after-sha');
    assert.ok(result.blocking_issues.includes('Main repo HEAD changed during sandbox execution'));
  });

  it('main dirty after is recorded as safety finding', () => {
    const def = makeDefinition();
    writeFileSync(blockJsonPath, JSON.stringify(def, null, 2));

    let statusCallCount = 0;
    const run = (cwd: string, command: string, args: string[]) => {
      if (command === 'git' && args[0] === 'status' && args[1] === '--porcelain') {
        statusCallCount++;
        if (statusCallCount === 1) {
          return { status: 0, stdout: '', stderr: '' };
        }
        return { status: 0, stdout: 'M file.ts\n', stderr: '' };
      }
      if (command === 'git' && args[0] === 'rev-parse') {
        return { status: 0, stdout: 'abc123\n', stderr: '' };
      }
      if (command === 'git' && args[0] === 'worktree' && args[1] === 'add') {
        return { status: 0, stdout: '', stderr: '' };
      }
      if (command === 'git' && args[0] === 'worktree' && args[1] === 'list') {
        return { status: 0, stdout: '', stderr: '' };
      }
      if (command === 'git' && args[0] === 'worktree' && args[1] === 'remove') {
        return { status: 0, stdout: '', stderr: '' };
      }
      if (command === 'npm') {
        return { status: 0, stdout: 'ok', stderr: '' };
      }
      return { status: 0, stdout: '', stderr: '' };
    };

    const result = runBlockSandbox({
      blockDefinitionPath: blockJsonPath,
      runCommand: run,
    });

    assert.strictEqual(result.main_status_before, 'clean');
    assert.strictEqual(result.main_status_after, 'dirty');
    assert.ok(result.safety_findings.includes('Main working tree changed during sandbox execution'));
  });

  it('worktree registration status is in result', () => {
    const def = makeDefinition();
    writeFileSync(blockJsonPath, JSON.stringify(def, null, 2));

    const run = createFakeRunCommand({
      'git worktree add': { status: 0, stdout: '', stderr: '' },
      'git worktree list --porcelain': { status: 0, stdout: `worktree ${resolve(join(process.cwd(), 'tmp', 'block-sandbox', blockId))}\nHEAD abc123\n`, stderr: '' },
      'npm run typecheck': { status: 0, stdout: 'ok', stderr: '' },
      'npm run build': { status: 0, stdout: 'ok', stderr: '' },
      'npm test': { status: 0, stdout: 'ok', stderr: '' },
      'git worktree remove': { status: 0, stdout: '', stderr: '' },
    });

    const result = runBlockSandbox({
      blockDefinitionPath: blockJsonPath,
      runCommand: run,
    });

    assert.strictEqual(result.worktree_registered, true);
  });

  it('path validation status is in result', () => {
    const def = makeDefinition();
    writeFileSync(blockJsonPath, JSON.stringify(def, null, 2));

    const run = createFakeRunCommand({
      'git worktree add': { status: 0, stdout: '', stderr: '' },
      'npm run typecheck': { status: 0, stdout: 'ok', stderr: '' },
      'npm run build': { status: 0, stdout: 'ok', stderr: '' },
      'npm test': { status: 0, stdout: 'ok', stderr: '' },
      'git worktree remove': { status: 0, stdout: '', stderr: '' },
    });

    const result = runBlockSandbox({
      blockDefinitionPath: blockJsonPath,
      runCommand: run,
    });

    assert.strictEqual(result.path_validation, 'pass');
  });

  it('ghp_ token is redacted in report', () => {
    const def = makeDefinition();
    writeFileSync(blockJsonPath, JSON.stringify(def, null, 2));

    const run = createFakeRunCommand({
      'git worktree add': { status: 0, stdout: '', stderr: '' },
      'npm run typecheck': { status: 0, stdout: 'ok ghp_1234567890abcdef1234567890abcdef123456', stderr: '' },
      'npm run build': { status: 0, stdout: 'ok', stderr: '' },
      'npm test': { status: 0, stdout: 'ok', stderr: '' },
      'git worktree remove': { status: 0, stdout: '', stderr: '' },
    });

    const result = runBlockSandbox({
      blockDefinitionPath: blockJsonPath,
      runCommand: run,
    });

    const report = readFileSync(result.output_path, 'utf-8');
    assert.ok(!report.includes('ghp_1234567890abcdef1234567890abcdef123456'));
    assert.ok(report.includes('[REDACTED]'));
    assert.strictEqual(result.redaction_applied, true);
  });

  it('github_pat_ token is redacted in report', () => {
    const def = makeDefinition();
    writeFileSync(blockJsonPath, JSON.stringify(def, null, 2));

    const run = createFakeRunCommand({
      'git worktree add': { status: 0, stdout: '', stderr: '' },
      'npm run typecheck': { status: 0, stdout: 'ok github_pat_11ABCDEFGabcdefghijklmnopqrstuvwxyz1234567890ABCD', stderr: '' },
      'npm run build': { status: 0, stdout: 'ok', stderr: '' },
      'npm test': { status: 0, stdout: 'ok', stderr: '' },
      'git worktree remove': { status: 0, stdout: '', stderr: '' },
    });

    const result = runBlockSandbox({
      blockDefinitionPath: blockJsonPath,
      runCommand: run,
    });

    const report = readFileSync(result.output_path, 'utf-8');
    assert.ok(!report.includes('github_pat_11ABCDEFGabcdefghijklmnopqrstuvwxyz1234567890ABCD'));
    assert.ok(report.includes('[REDACTED]'));
  });

  it('generic *_TOKEN= is redacted in report', () => {
    const def = makeDefinition();
    writeFileSync(blockJsonPath, JSON.stringify(def, null, 2));

    const run = createFakeRunCommand({
      'git worktree add': { status: 0, stdout: '', stderr: '' },
      'npm run typecheck': { status: 0, stdout: 'ok MY_SERVICE_TOKEN=supersecrettokenvalue123', stderr: '' },
      'npm run build': { status: 0, stdout: 'ok', stderr: '' },
      'npm test': { status: 0, stdout: 'ok', stderr: '' },
      'git worktree remove': { status: 0, stdout: '', stderr: '' },
    });

    const result = runBlockSandbox({
      blockDefinitionPath: blockJsonPath,
      runCommand: run,
    });

    const report = readFileSync(result.output_path, 'utf-8');
    assert.ok(!report.includes('MY_SERVICE_TOKEN=supersecrettokenvalue123'));
    assert.ok(report.includes('[REDACTED_TOKEN]'));
  });

  it('cleanup verified false when worktree still listed after remove', () => {
    const def = makeDefinition();
    writeFileSync(blockJsonPath, JSON.stringify(def, null, 2));

    const sandboxFullPath = resolve(join(process.cwd(), 'tmp', 'block-sandbox', blockId));
    const run = createFakeRunCommand({
      'git worktree add': { status: 0, stdout: '', stderr: '' },
      'git worktree list --porcelain': { status: 0, stdout: `worktree ${sandboxFullPath}\nHEAD abc123\n`, stderr: '' },
      'npm run typecheck': { status: 0, stdout: 'ok', stderr: '' },
      'npm run build': { status: 0, stdout: 'ok', stderr: '' },
      'npm test': { status: 0, stdout: 'ok', stderr: '' },
      'git worktree remove': { status: 0, stdout: '', stderr: '' },
    });

    const result = runBlockSandbox({
      blockDefinitionPath: blockJsonPath,
      runCommand: run,
    });

    assert.strictEqual(result.cleanup_result, 'success');
    assert.strictEqual(result.cleanup_verified, false);
  });
});

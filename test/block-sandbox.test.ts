import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { writeFileSync, readFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join, resolve, normalize } from 'node:path';
import { tmpdir } from 'node:os';
import { runBlockSandbox } from '../src/block/block-sandbox.js';
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
});

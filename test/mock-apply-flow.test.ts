import { describe, test } from 'node:test';
import assert from 'node:assert';
import { existsSync, rmSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { loadTask } from '../src/task-loader.js';
import { runMockApplyFlow } from '../src/mock-apply-flow.js';
import { join } from 'node:path';

const FIXTURE_REPO = join(process.cwd(), 'fixtures', 'repo');
const ORIGIN_REPO = join(process.cwd(), 'fixtures', 'origin.git');
const RUN_DIR = join(process.cwd(), 'runs', 'test-task');

function git(args: string[]): void {
  const result = spawnSync('git', args, {
    cwd: FIXTURE_REPO,
    encoding: 'utf-8',
    shell: false,
    timeout: 15000,
  });
  if (result.status !== 0 && result.status !== null) {
    if (args[0] === 'branch' && args[1] === '-D' && result.stderr.includes('not found')) {
      return;
    }
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  }
}

function setupFixtureRepo(): void {
  if (!existsSync(join(FIXTURE_REPO, '.git'))) {
    git(['init']);
    git(['add', '.']);
    git(['commit', '-m', 'init']);
    git(['branch', '-m', 'main']);
  }

  if (!existsSync(ORIGIN_REPO)) {
    const result = spawnSync('git', ['init', '--bare', ORIGIN_REPO], {
      encoding: 'utf-8',
      shell: false,
      timeout: 15000,
    });
    if (result.status !== 0) {
      throw new Error(`git init --bare failed: ${result.stderr}`);
    }
  }

  const remoteResult = spawnSync('git', ['remote'], {
    cwd: FIXTURE_REPO,
    encoding: 'utf-8',
    shell: false,
  });
  if (!remoteResult.stdout.includes('origin')) {
    git(['remote', 'add', 'origin', ORIGIN_REPO]);
    git(['push', '-u', 'origin', 'main']);
  }
}

function cleanupFixture(): void {
  setupFixtureRepo();
  git(['checkout', 'main']);
  try {
    git(['branch', '-D', 'ai/test-task']);
  } catch {
    // ignore if branch doesn't exist
  }
  const helloFile = join(FIXTURE_REPO, 'src', 'hello.ts');
  if (existsSync(helloFile)) {
    rmSync(helloFile);
  }
  if (existsSync(RUN_DIR)) {
    rmSync(RUN_DIR, { recursive: true });
  }
}

describe('mock-apply-flow', () => {
  test('success path creates state, attempt, and artifacts', async () => {
    cleanupFixture();

    const rawJson = JSON.stringify({
      mode: 'file_update',
      files: [
        { path: 'src/hello.ts', content: "export const hello = 'world';" },
      ],
    });

    const task = loadTask('test/fixtures/tasks.yaml', 'test-task');
    const result = runMockApplyFlow(task, rawJson);

    assert.strictEqual(result.success, true, `Expected success, got logs: ${result.logs}`);

    const statePath = join(RUN_DIR, 'state.json');
    assert(existsSync(statePath), 'state.json should exist');
    const state = JSON.parse(readFileSync(statePath, 'utf-8'));
    assert.strictEqual(state.status, 'approved', `Expected approved, got ${state.status}`);
    assert.strictEqual(state.current_attempt, 1);

    const attemptDir = join(RUN_DIR, 'attempt-1');
    assert(existsSync(attemptDir), 'attempt-1 should exist');
    assert(existsSync(join(attemptDir, 'raw-kimi-output.json')), 'raw-kimi-output.json should exist');
    assert(existsSync(join(attemptDir, 'parsed-kimi-output.json')), 'parsed-kimi-output.json should exist');
    assert(existsSync(join(attemptDir, 'patch-manifest.json')), 'patch-manifest.json should exist');
    assert(existsSync(join(attemptDir, 'logs.txt')), 'logs.txt should exist');

    cleanupFixture();
  });
});

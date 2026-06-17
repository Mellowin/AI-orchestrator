import { describe, test } from 'node:test';
import assert from 'node:assert';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createDisposablePilotRepo } from '../scripts/create-disposable-pilot-repo.mjs';
import { hasRealRunOptIns, buildBlockJson, runDemo } from '../scripts/run-disposable-pilot-demo.mjs';

const projectRoot = resolve(join(fileURLToPath(import.meta.url), '..', '..'));
const exampleBlockPath = join(projectRoot, 'examples', 'disposable-pilot', 'block.json');
const runScriptPath = join(projectRoot, 'scripts', 'run-disposable-pilot-demo.mjs');

function cleanEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of [
    'ALLOW_REAL_PROVIDER',
    'ALLOW_KIMI_REVIEWER',
    'KIMI_API_KEY',
    'REAL_BLOCK_RUN_AI',
    'ALLOW_REAL_REPO_APPLY',
    'ALLOW_REAL_REPO_COMMIT',
    'ALLOW_REAL_REPO_PUSH',
  ]) {
    delete env[key];
  }
  return env;
}

function runScript(extraEnv: Record<string, string | undefined> = {}): {
  status: number;
  stdout: string;
  stderr: string;
} {
  const env = cleanEnv();
  for (const [key, value] of Object.entries(extraEnv)) {
    if (value === undefined) {
      delete env[key];
    } else {
      env[key] = value;
    }
  }
  const result = spawnSync('node', [runScriptPath], {
    cwd: projectRoot,
    env,
    encoding: 'utf-8',
    shell: false,
    timeout: 60000,
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  };
}

function isOutsideProject(candidate: string, project: string): boolean {
  const resolvedCandidate = resolve(candidate);
  const resolvedProject = resolve(project);
  return (
    resolvedCandidate !== resolvedProject &&
    !resolvedCandidate.startsWith(resolvedProject + '\\') &&
    !resolvedCandidate.startsWith(resolvedProject + '/')
  );
}

describe('disposable pilot demo kit', () => {
  test('create script exists and creates repo outside project root', () => {
    const { tempDir, repoPath } = createDisposablePilotRepo();
    try {
      assert(existsSync(repoPath), 'Repo directory should exist');
      assert(isOutsideProject(repoPath, projectRoot), `Repo should be outside project root: ${repoPath}`);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('example block exists and is valid JSON', () => {
    const raw = readFileSync(exampleBlockPath, 'utf-8');
    const block = JSON.parse(raw);
    assert.strictEqual(typeof block.block_id, 'string');
    assert.notStrictEqual(block.work_branch, 'main');
    assert.notStrictEqual(block.work_branch, 'master');
    assert(Array.isArray(block.tasks));
    assert(block.tasks.length > 0);

    const task = block.tasks[0];
    assert(Array.isArray(task.allowed_files));
    assert(task.allowed_files.includes('README.md'));
    assert(Array.isArray(task.denied_files));
    assert(task.denied_files.includes('.env'));
    assert(task.denied_files.includes('.env.local'));
    assert(task.denied_files.includes('node_modules/**'));
    assert(task.denied_files.includes('.git/**'));
  });

  test('buildBlockJson replaces repo_path', () => {
    const json = buildBlockJson(exampleBlockPath, '/tmp/demo-repo');
    const block = JSON.parse(json);
    assert.strictEqual(block.repo_path, '/tmp/demo-repo');
  });

  test('demo script without real env exits 0', () => {
    const result = runScript();
    assert.strictEqual(result.status, 0, `Expected exit 0: ${result.stderr}`);
  });

  test('demo script without real env prints next command', () => {
    const result = runScript();
    const output = result.stdout + result.stderr;
    assert(output.includes('real-block-disposable-pilot'), `Should print pilot command: ${output}`);
    assert(output.includes('To run with real Kimi'), `Should print instructions: ${output}`);
  });

  test('demo script without real env does not call provider', () => {
    const result = runScript();
    const output = result.stdout + result.stderr;
    assert(output.includes('Disposable pilot demo prepared.'), `Should only prepare repo: ${output}`);
    assert(!output.includes('"ok":'), `Should not contain pilot JSON result: ${output}`);
  });

  test('runDemo returns repo outside project root and does not dirty project repo', async () => {
    const demo = await runDemo(cleanEnv());
    try {
      assert(isOutsideProject(demo.repoPath, projectRoot), `Repo should be outside project: ${demo.repoPath}`);
      assert.strictEqual(demo.ranRealPilot, false);
      assert.strictEqual(demo.ok, true);
    } finally {
      rmSync(demo.tempDir, { recursive: true, force: true });
    }
  });

  test('hasRealRunOptIns requires all opt-ins', () => {
    const base: Record<string, string> = {
      ALLOW_REAL_PROVIDER: 'true',
      ALLOW_KIMI_REVIEWER: 'true',
      KIMI_API_KEY: 'sk-test',
      REAL_BLOCK_RUN_AI: '1',
      ALLOW_REAL_REPO_APPLY: 'true',
      ALLOW_REAL_REPO_COMMIT: 'true',
      ALLOW_REAL_REPO_PUSH: 'true',
    };
    assert.strictEqual(hasRealRunOptIns(base), true);

    for (const key of Object.keys(base)) {
      const missing = { ...base, [key]: key === 'KIMI_API_KEY' ? '' : 'false' };
      assert.strictEqual(hasRealRunOptIns(missing), false, `Expected false when ${key} is missing/invalid`);
    }
  });

  test('output does not leak tokens', async () => {
    const demo = await runDemo({
      ...cleanEnv(),
      ALLOW_REAL_PROVIDER: 'true',
      ALLOW_KIMI_REVIEWER: 'true',
      KIMI_API_KEY: 'sk-live-secret-token',
      REAL_BLOCK_RUN_AI: '1',
      ALLOW_REAL_REPO_APPLY: 'true',
      ALLOW_REAL_REPO_COMMIT: 'true',
      ALLOW_REAL_REPO_PUSH: 'true',
    });
    try {
      assert(!demo.output.includes('sk-live-secret-token'), `Output leaked token: ${demo.output}`);
    } finally {
      rmSync(demo.tempDir, { recursive: true, force: true });
    }
  });
});

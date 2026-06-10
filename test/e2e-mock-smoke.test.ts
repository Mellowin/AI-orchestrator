import { describe, test } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

let counter = 0;

function createSmokeEnv(): {
  taskId: string;
  cwd: string;
  repoPath: string;
  cleanup: () => void;
} {
  const id = `${Date.now()}-${counter++}`;
  const taskId = `smoke-${id}`;
  const baseDir = join(process.cwd(), 'tmp', `smoke-${id}`);
  const repoPath = baseDir;
  mkdirSync(baseDir, { recursive: true });

  writeFileSync(join(repoPath, 'package.json'), '{"name":"smoke-test"}\n', 'utf-8');
  writeFileSync(join(repoPath, '.gitignore'), 'runs/\norigin.git/\n', 'utf-8');
  mkdirSync(join(repoPath, 'src'), { recursive: true });
  writeFileSync(join(repoPath, 'src', 'index.ts'), 'export const v = 1;\n', 'utf-8');

  const tasksYaml = `tasks:
  - id: ${taskId}
    title: "Smoke test task"
    repo_path: "."
    base_branch: "main"
    work_branch: "ai/${taskId}"
    goal: "Update src/index.ts"
    context_files:
      - "src/index.ts"
    checks:
      - command: echo
        args: ["checks-passed"]
    guardrails:
      deny_modify:
        - ".env"
        - ".env.*"
        - "node_modules/**"
        - ".git/**"
      max_lines_changed: 150
      require_tests: false
      auto_commit: false
      auto_push: false
      auto_merge: false
`;
  writeFileSync(join(baseDir, 'tasks.yaml'), tasksYaml, 'utf-8');

  spawnSync('git', ['init'], { cwd: repoPath, encoding: 'utf-8', shell: false });
  spawnSync('git', ['config', 'user.email', 'smoke@example.com'], { cwd: repoPath, encoding: 'utf-8', shell: false });
  spawnSync('git', ['config', 'user.name', 'Smoke Test'], { cwd: repoPath, encoding: 'utf-8', shell: false });
  spawnSync('git', ['add', '.'], { cwd: repoPath, encoding: 'utf-8', shell: false });
  spawnSync('git', ['commit', '-m', 'init', '--no-gpg-sign'], {
    cwd: repoPath,
    encoding: 'utf-8',
    shell: false,
  });
  spawnSync('git', ['branch', '-M', 'main'], { cwd: repoPath, encoding: 'utf-8', shell: false });

  const originPath = join(baseDir, 'origin.git');
  spawnSync('git', ['init', '--bare', originPath], { encoding: 'utf-8', shell: false });
  spawnSync('git', ['remote', 'add', 'origin', originPath], {
    cwd: repoPath,
    encoding: 'utf-8',
    shell: false,
  });
  spawnSync('git', ['push', '-u', 'origin', 'main'], {
    cwd: repoPath,
    encoding: 'utf-8',
    shell: false,
  });

  return {
    taskId,
    cwd: baseDir,
    repoPath,
    cleanup: () => {
      rmSync(baseDir, { recursive: true, force: true });
    },
  };
}

function runCli(
  args: string[],
  cwd: string,
  envOverrides: Record<string, string> = {}
): { status: number; stdout: string; stderr: string } {
  const env = { ...process.env };
  delete env.AI_PROVIDER;
  delete env.MOCK_AI_RESPONSE;
  delete env.KIMI_API_KEY;
  delete env.KIMI_MODEL;
  delete env.KIMI_BASE_URL;
  delete env.KIMI_USER_AGENT;
  delete env.OPENAI_API_KEY;
  delete env.MOCK_AI;
  Object.assign(env, envOverrides);

  const result = spawnSync(
    `npx tsx "${join(process.cwd(), 'src', 'cli.ts')}" ${args.join(' ')}`,
    {
      cwd,
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

describe('e2e mock smoke', () => {
  test('happy path: ai-generate then ai-apply updates file without network or push', () => {
    const { taskId, cwd, repoPath, cleanup } = createSmokeEnv();
    try {
      const mockResponse = JSON.stringify({
        mode: 'file_update',
        files: [{ path: 'src/index.ts', content: 'export const v = 42;\n' }],
      });

      // Step 1: ai-generate
      const genResult = runCli(['ai-generate', taskId], cwd, {
        AI_PROVIDER: 'mock',
        MOCK_AI_RESPONSE: mockResponse,
      });
      assert.strictEqual(genResult.status, 0, `ai-generate failed: ${genResult.stderr}`);
      const aiOutputPath = join(cwd, 'runs', taskId, 'ai-output.json');
      assert(existsSync(aiOutputPath), 'ai-output.json should exist after ai-generate');

      // Step 2: ai-apply
      const appResult = runCli(['ai-apply', taskId], cwd);
      assert.strictEqual(appResult.status, 0, `ai-apply failed: ${appResult.stderr}`);
      assert(appResult.stdout.includes('[ai-apply] Success'), `Expected success message: ${appResult.stdout}`);

      // Assert file updated
      const updatedContent = readFileSync(join(repoPath, 'src', 'index.ts'), 'utf-8');
      assert(updatedContent.includes('v = 42'), `File should be updated, got: ${updatedContent}`);

      // Assert state persisted
      const statePath = join(cwd, 'runs', taskId, 'state.json');
      assert(existsSync(statePath), 'state.json should exist after ai-apply');
      const state = JSON.parse(readFileSync(statePath, 'utf-8'));
      assert.strictEqual(state.status, 'approved', `Expected approved status, got: ${state.status}`);

      // Assert attempt directory created
      assert(existsSync(join(cwd, 'runs', taskId, 'attempt-1')), 'attempt-1 should exist');

      // Assert current branch is work branch, not main
      const branchResult = spawnSync('git', ['branch', '--show-current'], {
        cwd: repoPath,
        encoding: 'utf-8',
        shell: false,
      });
      const currentBranch = branchResult.stdout?.trim();
      assert.strictEqual(currentBranch, `ai/${taskId}`, `Expected work branch, got: ${currentBranch}`);

      // Assert no push happened (work branch not on remote)
      const remoteBranches = spawnSync('git', ['branch', '-r'], {
        cwd: repoPath,
        encoding: 'utf-8',
        shell: false,
      });
      assert(
        !remoteBranches.stdout?.includes(`ai/${taskId}`),
        `Work branch should not be pushed, got remote branches: ${remoteBranches.stdout}`
      );
    } finally {
      cleanup();
    }
  });
});

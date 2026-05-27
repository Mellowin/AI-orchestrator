import { spawnSync } from 'node:child_process';
import { describe, test } from 'node:test';
import assert from 'node:assert';
import { existsSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

let counter = 0;

function createPipelineEnv(): {
  taskId: string;
  cwd: string;
  runsDir: string;
  repoPath: string;
  cleanup: () => void;
} {
  const id = `${Date.now()}-${counter++}`;
  const taskId = `pipeline-${id}`;
  const baseDir = join(process.cwd(), 'tmp', `pipeline-${id}`);
  const runsDir = join(baseDir, 'runs');
  const repoPath = baseDir;
  mkdirSync(baseDir, { recursive: true });

  writeFileSync(join(repoPath, 'package.json'), '{"name":"original","version":"1.0.0"}\n', 'utf-8');
  writeFileSync(join(repoPath, '.gitignore'), 'runs/\norigin.git/\n', 'utf-8');

  const tasksYaml = `tasks:
  - id: ${taskId}
    title: "Pipeline test task"
    repo_path: "."
    base_branch: "main"
    work_branch: "ai/${taskId}"
    goal: "Test pipeline"
    context_files:
      - "package.json"
    checks: []
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
  spawnSync('git', ['add', '.'], { cwd: repoPath, encoding: 'utf-8', shell: false });
  spawnSync('git', ['commit', '-m', 'init', '--no-gpg-sign'], {
    cwd: repoPath,
    encoding: 'utf-8',
    shell: false,
  });
  spawnSync('git', ['branch', '-m', 'main'], { cwd: repoPath, encoding: 'utf-8', shell: false });

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
    runsDir,
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

describe('cli pipeline', () => {
  test('mock fenced ai-output passes full pipeline', () => {
    const { taskId, cwd, runsDir, repoPath, cleanup } = createPipelineEnv();
    try {
      const fencedResponse =
        '```json\n' +
        '{"mode":"file_update","files":[{"path":"package.json","content":"{ \\"name\\": \\"pipeline-fenced-test\\", \\"version\\": \\"1.0.0\\" }\\n"}]}\n' +
        '```';

      // Step 1: ai-generate
      const genResult = runCli(['ai-generate', taskId], cwd, {
        AI_PROVIDER: 'mock',
        MOCK_AI_RESPONSE: fencedResponse,
      });
      assert.strictEqual(genResult.status, 0, `Expected ai-generate success, got stderr: ${genResult.stderr}`);
      const aiOutputPath = join(runsDir, taskId, 'ai-output.json');
      assert(existsSync(aiOutputPath), 'ai-output.json should exist after ai-generate');
      const aiOutputContent = readFileSync(aiOutputPath, 'utf-8');
      assert(aiOutputContent.includes('```json'), 'ai-output.json should contain fenced json');

      // Step 2: ai-validate
      const valResult = runCli(['ai-validate', taskId], cwd);
      assert.strictEqual(valResult.status, 0, `Expected ai-validate success, got stderr: ${valResult.stderr}`);
      assert(valResult.stdout.includes('[ai-validate] Valid AI output'), `Expected Valid AI output, got stdout: ${valResult.stdout}`);
      assert(valResult.stdout.includes('[ai-validate] Guardrails: ok'), `Expected Guardrails: ok, got stdout: ${valResult.stdout}`);
      assert(!existsSync(join(runsDir, taskId, 'state.json')), 'state.json should not exist after validate');
      assert(!existsSync(join(runsDir, taskId, 'attempt-1')), 'attempt-1 should not exist after validate');

      // Step 3: ai-apply
      const appResult = runCli(['ai-apply', taskId], cwd);
      assert.strictEqual(appResult.status, 0, `Expected ai-apply success, got stderr: ${appResult.stderr}`);
      assert(appResult.stdout.includes('[ai-apply] Success'), `Expected Success, got stdout: ${appResult.stdout}`);
      assert(
        readFileSync(join(repoPath, 'package.json'), 'utf-8').includes('"name": "pipeline-fenced-test"'),
        'package.json should be updated'
      );
      assert(existsSync(join(runsDir, taskId, 'attempt-1')), 'attempt-1 should exist after apply');
      assert(existsSync(join(runsDir, taskId, 'state.json')), 'state.json should exist after apply');
    } finally {
      cleanup();
    }
  });
});

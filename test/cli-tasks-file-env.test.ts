import { spawnSync } from 'node:child_process';
import { describe, test } from 'node:test';
import assert from 'node:assert';
import { existsSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

let counter = 0;

describe('cli TASKS_FILE env override', () => {
  test('ai-validate uses custom tasks file from TASKS_FILE env', () => {
    const id = `${Date.now()}-${counter++}`;
    const taskId = `tasks-file-${id}`;
    const baseDir = join(process.cwd(), 'tmp', `tasks-file-test-${id}`);
    const runsDir = join(baseDir, 'runs');

    mkdirSync(baseDir, { recursive: true });

    writeFileSync(join(baseDir, 'package.json'), '{}', 'utf-8');

    spawnSync('git', ['init'], { cwd: baseDir, encoding: 'utf-8', shell: false });
    spawnSync('git', ['config', 'user.email', 'ci@example.com'], { cwd: baseDir, encoding: 'utf-8', shell: false });
    spawnSync('git', ['config', 'user.name', 'CI User'], { cwd: baseDir, encoding: 'utf-8', shell: false });
    spawnSync('git', ['add', '.'], { cwd: baseDir, encoding: 'utf-8', shell: false });
    spawnSync('git', ['commit', '-m', 'init', '--no-gpg-sign'], {
      cwd: baseDir,
      encoding: 'utf-8',
      shell: false,
    });
    spawnSync('git', ['branch', '-m', 'main'], { cwd: baseDir, encoding: 'utf-8', shell: false });

    const customTasksPath = join(baseDir, 'custom-tasks.yaml');
    const tasksYaml = `tasks:
  - id: ${taskId}
    title: "Custom tasks file test"
    repo_path: "."
    base_branch: "main"
    work_branch: "ai/${taskId}"
    goal: "Test TASKS_FILE override"
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
    writeFileSync(customTasksPath, tasksYaml, 'utf-8');

    const runTaskDir = join(runsDir, taskId);
    mkdirSync(runTaskDir, { recursive: true });
    writeFileSync(
      join(runTaskDir, 'ai-output.json'),
      '{"mode":"file_update","files":[],"notes":"No changes needed"}',
      'utf-8'
    );

    const env = { ...process.env };
    delete env.AI_PROVIDER;
    delete env.MOCK_AI_RESPONSE;
    delete env.KIMI_API_KEY;
    delete env.KIMI_MODEL;
    delete env.KIMI_BASE_URL;
    delete env.KIMI_USER_AGENT;
    delete env.OPENAI_API_KEY;
    delete env.MOCK_AI;
    env.TASKS_FILE = customTasksPath;

    const result = spawnSync(
      `npx tsx "${join(process.cwd(), 'src', 'cli.ts')}" ai-validate ${taskId}`,
      {
        cwd: baseDir,
        env,
        encoding: 'utf-8',
        shell: true,
        timeout: 15000,
      }
    );

    try {
      assert.strictEqual(result.status, 0, `Expected success, got stderr: ${result.stderr}`);
      assert(result.stdout.includes(`[ai-validate] Task: ${taskId}`), `Expected task id in stdout, got: ${result.stdout}`);
      assert(result.stdout.includes('[ai-validate] Files: 0'), `Expected Files: 0, got stdout: ${result.stdout}`);
      assert(result.stdout.includes('[ai-validate] No file changes proposed'), `Expected no changes message, got stdout: ${result.stdout}`);
      assert(result.stdout.includes('[ai-validate] Guardrails: ok'), `Expected Guardrails: ok, got stdout: ${result.stdout}`);
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });
});

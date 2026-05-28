import { spawnSync } from 'node:child_process';
import { describe, test } from 'node:test';
import assert from 'node:assert';
import { existsSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

let counter = 0;

function createPreviewEnv(): {
  taskId: string;
  cwd: string;
  runsDir: string;
  repoPath: string;
  cleanup: () => void;
} {
  const id = `${Date.now()}-${counter++}`;
  const taskId = `preview-${id}`;
  const baseDir = join(process.cwd(), 'tmp', `preview-${id}`);
  const runsDir = join(baseDir, 'runs');
  const repoPath = baseDir;
  mkdirSync(baseDir, { recursive: true });

  writeFileSync(
    join(repoPath, 'package.json'),
    '{\n  "name": "preview-test",\n  "version": "1.0.0"\n}\n',
    'utf-8'
  );

  spawnSync('git', ['init'], { cwd: repoPath, encoding: 'utf-8', shell: false });
  spawnSync('git', ['add', '.'], { cwd: repoPath, encoding: 'utf-8', shell: false });
  spawnSync('git', ['commit', '-m', 'init', '--no-gpg-sign'], {
    cwd: repoPath,
    encoding: 'utf-8',
    shell: false,
  });

  const tasksYaml = `tasks:
  - id: ${taskId}
    title: "Preview test task"
    repo_path: "."
    base_branch: "main"
    work_branch: "ai/${taskId}"
    goal: "Test preview"
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

function runAiPreview(
  taskId: string,
  cwd: string
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

  const result = spawnSync(
    `npx tsx "${join(process.cwd(), 'src', 'cli.ts')}" ai-preview ${taskId}`,
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

describe('cli ai-preview', () => {
  test('ai-preview fails when ai-output.json is missing', () => {
    const { taskId, cwd, runsDir, cleanup } = createPreviewEnv();
    try {
      const runTaskDir = join(runsDir, taskId);
      if (existsSync(runTaskDir)) {
        rmSync(runTaskDir, { recursive: true });
      }

      const result = runAiPreview(taskId, cwd);
      assert.strictEqual(result.status, 1, `Expected failure, got stderr: ${result.stderr}`);
      assert(
        result.stderr.includes('ai-output.json not found. Run ai-generate first.'),
        `Expected missing file message, got stderr: ${result.stderr}`
      );
      assert(!existsSync(join(runTaskDir, 'state.json')), 'state.json should not exist');
      assert(!existsSync(join(runTaskDir, 'attempt-1')), 'attempt-1 should not exist');
    } finally {
      cleanup();
    }
  });

  test('ai-preview shows existing file line delta', () => {
    const { taskId, cwd, runsDir, cleanup } = createPreviewEnv();
    try {
      const runTaskDir = join(runsDir, taskId);
      mkdirSync(runTaskDir, { recursive: true });
      writeFileSync(
        join(runTaskDir, 'ai-output.json'),
        JSON.stringify({
          mode: 'file_update',
          files: [
            { path: 'package.json', content: '{"name":"updated","version":"1.0.0"}' },
          ],
        }),
        'utf-8'
      );

      const result = runAiPreview(taskId, cwd);
      assert.strictEqual(result.status, 0, `Expected success, got stderr: ${result.stderr}`);
      assert(result.stdout.includes('[ai-preview] Files: 1'), `Expected Files: 1, got stdout: ${result.stdout}`);
      assert(result.stdout.includes('package.json'), `Expected package.json, got stdout: ${result.stdout}`);
      assert(result.stdout.includes('exists: yes'), `Expected exists: yes, got stdout: ${result.stdout}`);
      assert(result.stdout.includes('current lines:'), `Expected current lines, got stdout: ${result.stdout}`);
      assert(result.stdout.includes('proposed lines:'), `Expected proposed lines, got stdout: ${result.stdout}`);
      assert(result.stdout.includes('delta:'), `Expected delta, got stdout: ${result.stdout}`);
    } finally {
      cleanup();
    }
  });

  test('ai-preview shows new file', () => {
    const { taskId, cwd, runsDir, repoPath, cleanup } = createPreviewEnv();
    try {
      const runTaskDir = join(runsDir, taskId);
      mkdirSync(runTaskDir, { recursive: true });
      writeFileSync(
        join(runTaskDir, 'ai-output.json'),
        '{"mode":"file_update","files":[{"path":"src/new-file.ts","content":"console.log(\'new\');\\n"}]}',
        'utf-8'
      );

      const result = runAiPreview(taskId, cwd);
      assert.strictEqual(result.status, 0, `Expected success, got stderr: ${result.stderr}`);
      assert(result.stdout.includes('exists: no'), `Expected exists: no, got stdout: ${result.stdout}`);
      assert(result.stdout.includes('current lines: 0'), `Expected current lines: 0, got stdout: ${result.stdout}`);
      assert(result.stdout.includes('proposed lines: 1'), `Expected proposed lines: 1, got stdout: ${result.stdout}`);
      assert(result.stdout.includes('delta: +1'), `Expected delta: +1, got stdout: ${result.stdout}`);
      assert(!existsSync(join(repoPath, 'src', 'new-file.ts')), 'new-file.ts should not be created');
    } finally {
      cleanup();
    }
  });

  test('ai-preview fails guardrails for denied path', () => {
    const { taskId, cwd, runsDir, repoPath, cleanup } = createPreviewEnv();
    try {
      const runTaskDir = join(runsDir, taskId);
      mkdirSync(runTaskDir, { recursive: true });
      writeFileSync(
        join(runTaskDir, 'ai-output.json'),
        '{"mode":"file_update","files":[{"path":".env","content":"SECRET=1"}]}',
        'utf-8'
      );

      const result = runAiPreview(taskId, cwd);
      assert.strictEqual(result.status, 1, `Expected failure, got stderr: ${result.stderr}`);
      assert(
        result.stderr.includes('[ai-preview] Guardrails failed'),
        `Expected guardrails failed, got stderr: ${result.stderr}`
      );
      assert(!existsSync(join(repoPath, '.env')), '.env should not be created');
    } finally {
      cleanup();
    }
  });
});

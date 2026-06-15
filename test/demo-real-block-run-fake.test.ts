import { describe, test } from 'node:test';
import assert from 'node:assert';
import { existsSync, readFileSync, rmSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const PACKAGE_JSON_PATH = join(process.cwd(), 'package.json');
const DEMO_SCRIPT_PATH = join(process.cwd(), 'scripts', 'demo-real-block-run-fake.ts');
const PROJECT_ROOT = process.cwd();

const SECRET_PATTERN = /sk-[a-zA-Z0-9]{16,}/;
const BEARER_PATTERN = /Bearer\s+[a-zA-Z0-9_-]{10,}/;
const TOKEN_ASSIGN_PATTERN = /[A-Za-z0-9_]*TOKEN[A-Za-z0-9_]*\s*=\s*['"][^'"]{8,}['"]/;
const REAL_URL_PATTERN = /https:\/\/api\.(moonshot|openai)/;

function readDemoSource(): string {
  return readFileSync(DEMO_SCRIPT_PATH, 'utf-8');
}

function readPackage(): { scripts?: Record<string, string> } {
  return JSON.parse(readFileSync(PACKAGE_JSON_PATH, 'utf-8'));
}

function runDemo(): {
  status: number;
  stdout: string;
  stderr: string;
} {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    KEEP_DEMO_ARTIFACTS: '1',
  };
  const tsxCliPath = join(PROJECT_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const result = spawnSync(process.execPath, [tsxCliPath, DEMO_SCRIPT_PATH], {
    cwd: PROJECT_ROOT,
    env,
    encoding: 'utf-8',
    shell: false,
    timeout: 180000,
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  };
}

function extractValue(output: string, label: string): string | undefined {
  const match = output.match(new RegExp(`${label}:\\s*(.+)`));
  return match?.[1].trim();
}

describe('demo-real-block-run-fake static checks', () => {
  test('package.json contains demo:block:fake script', () => {
    const pkg = readPackage();
    assert.ok(pkg.scripts, 'package.json must have scripts');
    assert.strictEqual(typeof pkg.scripts['demo:block:fake'], 'string');
    assert.match(pkg.scripts['demo:block:fake'], /tsx scripts\/demo-real-block-run-fake\.ts/);
  });

  test('demo script file exists', () => {
    assert.ok(existsSync(DEMO_SCRIPT_PATH), 'scripts/demo-real-block-run-fake.ts must exist');
  });

  test('demo script source does not contain real-looking secrets', () => {
    const source = readDemoSource();
    assert.doesNotMatch(source, SECRET_PATTERN, 'must not contain sk- secret');
    assert.doesNotMatch(source, BEARER_PATTERN, 'must not contain Bearer token');
    assert.doesNotMatch(source, TOKEN_ASSIGN_PATTERN, 'must not contain real-looking TOKEN assignment');
  });

  test('demo script does not point to real API endpoints', () => {
    const source = readDemoSource();
    assert.doesNotMatch(source, REAL_URL_PATTERN, 'must not use real provider API URL');
  });

  test('demo script uses fake response envs', () => {
    const source = readDemoSource();
    assert.match(source, /REAL_BLOCK_TASK_KIMI_FAKE_RESPONSES/);
    assert.match(source, /REAL_BLOCK_TASK_REVIEWER_FAKE_RESPONSES/);
    assert.match(source, /REAL_BLOCK_TASK_FIX_KIMI_FAKE_RESPONSES/);
    assert.match(source, /REAL_BLOCK_TASK_SECOND_REVIEWER_FAKE_RESPONSES/);
  });

  test('demo script runs readiness before block run', () => {
    const source = readDemoSource();
    const readinessIndex = source.indexOf('real-block-run-ai-readiness');
    const runIndex = source.indexOf('real-block-run-ai\'');
    assert.ok(readinessIndex >= 0, 'must call readiness command');
    assert.ok(runIndex >= 0, 'must call block run command');
    assert.ok(readinessIndex < runIndex, 'readiness must be called before block run');
  });

  test('demo script does not use shell: true', () => {
    const source = readDemoSource();
    assert.doesNotMatch(source, /shell:\s*true/);
  });

  test('demo script does not call fetch/http directly', () => {
    const source = readDemoSource();
    assert.doesNotMatch(source, /\bfetch\s*\(/);
    assert.doesNotMatch(source, /http\.request/);
    assert.doesNotMatch(source, /https\.request/);
  });

  test('demo script configures local git user.email', () => {
    const source = readDemoSource();
    assert.match(source, /['"]config['"]\s*,\s*['"]user\.email['"]/);
  });

  test('demo script configures local git user.name', () => {
    const source = readDemoSource();
    assert.match(source, /['"]config['"]\s*,\s*['"]user\.name['"]/);
  });

  test('demo script does not use global git config', () => {
    const source = readDemoSource();
    assert.doesNotMatch(source, /['"]--global['"]/);
  });

  test('demo script checks git command failures', () => {
    const source = readDemoSource();
    assert.match(source, /if\s*\(\s*result\.status\s*!==\s*0\s*\)/);
    assert.match(source, /throw\s+new\s+Error\s*\(\s*`git\s*\$\{command\}/);
  });

  test('demo script does not include raw stderr/stdout in git failure error', () => {
    const source = readDemoSource();
    const runGitMatch = source.match(/function runGit\([\s\S]*?\n\}/);
    assert.ok(runGitMatch, 'runGit function must exist');
    const runGitSource = runGitMatch[0];
    assert.doesNotMatch(runGitSource, /result\.stderr/);
    assert.doesNotMatch(runGitSource, /result\.stdout/);
    assert.match(runGitSource, /throw new Error\(`git \$\{command\} failed with exit code \$\{result\.status\}`\)/);
  });

  test('demo script still uses shell:false for git', () => {
    const source = readDemoSource();
    const gitSpawnIndex = source.indexOf("spawnSync('git'");
    assert.ok(gitSpawnIndex >= 0, 'must spawn git');
    const snippet = source.slice(gitSpawnIndex, gitSpawnIndex + 200);
    assert.match(snippet, /shell:\s*false/);
  });

  test('demo script still uses shell:false for CLI calls', () => {
    const source = readDemoSource();
    const cliSpawnIndex = source.indexOf('spawnSync(process.execPath');
    assert.ok(cliSpawnIndex >= 0, 'must spawn CLI');
    const snippet = source.slice(cliSpawnIndex, cliSpawnIndex + 250);
    assert.match(snippet, /shell:\s*false/);
  });

  test('demo script does not call fetch/http/network directly', () => {
    const source = readDemoSource();
    assert.doesNotMatch(source, /\bfetch\s*\(/);
    assert.doesNotMatch(source, /http\.request/);
    assert.doesNotMatch(source, /https\.request/);
  });

  test('demo script does not use external remote URL', () => {
    const source = readDemoSource();
    assert.doesNotMatch(source, /github\.com/);
    assert.doesNotMatch(source, /gitlab\.com/);
    assert.match(source, /runGit\(\['remote',\s*'add',\s*'origin',\s*originPath\],\s*repoPath\)/);
  });

  test('demo script does not use git merge', () => {
    const source = readDemoSource();
    assert.doesNotMatch(source, /['"]merge['"]/);
  });

  test('demo script does not use git push --force', () => {
    const source = readDemoSource();
    assert.doesNotMatch(source, /['"]--force['"]/);
    assert.doesNotMatch(source, /['"]force['"]/);
  });

  test('demo script calls real-block-run-ai-report', () => {
    const source = readDemoSource();
    assert.match(source, /real-block-run-ai-report/);
  });

  test('demo script calls report after block run', () => {
    const source = readDemoSource();
    const runIndex = source.indexOf("'real-block-run-ai'");
    const reportIndex = source.indexOf("'real-block-run-ai-report'");
    assert.ok(runIndex >= 0, 'must call block run command');
    assert.ok(reportIndex >= 0, 'must call report command');
    assert.ok(runIndex < reportIndex, 'block run must be called before report');
  });

  test('demo script calls report after readiness', () => {
    const source = readDemoSource();
    const readinessIndex = source.indexOf('real-block-run-ai-readiness');
    const reportIndex = source.indexOf("'real-block-run-ai-report'");
    assert.ok(readinessIndex >= 0, 'must call readiness command');
    assert.ok(reportIndex >= 0, 'must call report command');
    assert.ok(readinessIndex < reportIndex, 'readiness must be called before report');
  });

  test('demo script uses runCli helper for report command', () => {
    const source = readDemoSource();
    assert.match(source, /runCli\(\['real-block-run-ai-report',\s*statePath\],\s*env\)/);
  });

  test('demo script asserts report exit code', () => {
    const source = readDemoSource();
    assert.match(source, /reportResult\.status\s*!==\s*0/);
  });

  test('demo script asserts report contains Block Run Report', () => {
    const source = readDemoSource();
    assert.match(source, /Block Run Report/);
  });

  test('demo script asserts report contains completed status', () => {
    const source = readDemoSource();
    assert.match(source, /Status:\s*completed/);
  });

  test('demo script asserts report contains task_1 accepted', () => {
    const source = readDemoSource();
    assert.match(source, /task_1/);
    assert.match(source, /accepted/);
  });

  test('demo script asserts report contains task_2 fixed_and_accepted', () => {
    const source = readDemoSource();
    assert.match(source, /task_2/);
    assert.match(source, /fixed_and_accepted/);
  });

  test('demo script asserts report contains fixCommitSha', () => {
    const source = readDemoSource();
    assert.match(source, /fixCommitSha/);
  });
});

describe('demo-real-block-run-fake runtime', () => {
  let demoResult: { status: number; stdout: string; stderr: string } | null = null;
  let tempDir: string | null = null;

  test('demo command executes successfully', () => {
    demoResult = runDemo();
    const output = demoResult.stdout + demoResult.stderr;
    if (demoResult.status !== 0) {
      console.error(output);
    }
    assert.strictEqual(demoResult.status, 0, `demo command should exit 0: ${output}`);
  });

  test('demo output includes temp repo path', () => {
    const output = (demoResult?.stdout ?? '') + (demoResult?.stderr ?? '');
    assert.match(output, /Temp repo:\s+\S+/);
    const match = output.match(/Temp repo:\s+(\S+)/);
    assert.ok(match);
    tempDir = match![1];
    assert.ok(existsSync(tempDir), 'temp repo path should exist during test');
  });

  test('demo output includes final state path', () => {
    const output = (demoResult?.stdout ?? '') + (demoResult?.stderr ?? '');
    assert.match(output, /Final state path:\s+\S+/);
  });

  test('demo output includes completed block status', () => {
    const output = (demoResult?.stdout ?? '') + (demoResult?.stderr ?? '');
    assert.match(output, /Block status:\s+completed/);
  });

  test('demo output includes accepted task 1', () => {
    const output = (demoResult?.stdout ?? '') + (demoResult?.stderr ?? '');
    assert.match(output, /Task task_1:\s+accepted/);
  });

  test('demo output includes fixed_and_accepted task 2', () => {
    const output = (demoResult?.stdout ?? '') + (demoResult?.stderr ?? '');
    assert.match(output, /Task task_2:\s+fixed_and_accepted/);
  });

  test('demo final state file exists and is completed', () => {
    const output = (demoResult?.stdout ?? '') + (demoResult?.stderr ?? '');
    const statePath = extractValue(output, 'Final state path');
    assert.ok(statePath, 'state path should be printed');
    assert.ok(existsSync(statePath!), 'state file should exist');
    const state = JSON.parse(readFileSync(statePath!, 'utf-8'));
    assert.strictEqual(state.status, 'completed');
    assert.ok(Array.isArray(state.taskResults));
    assert.strictEqual(state.taskResults.length, 2);
  });

  test('demo final state has fixCommitSha for task 2', () => {
    const output = (demoResult?.stdout ?? '') + (demoResult?.stderr ?? '');
    const statePath = extractValue(output, 'Final state path');
    assert.ok(statePath);
    const state = JSON.parse(readFileSync(statePath!, 'utf-8'));
    const task2 = state.taskResults.find((t: Record<string, unknown>) => t.taskId === 'task_2');
    assert.ok(task2, 'task_2 should exist in state');
    assert.strictEqual(typeof task2.fixCommitSha, 'string');
    assert.strictEqual(task2.fixCommitSha.length, 40);
  });

  test('demo output includes Block report section', () => {
    const output = (demoResult?.stdout ?? '') + (demoResult?.stderr ?? '');
    assert.match(output, /=== Block report ===/);
  });

  test('demo output includes Block Run Report', () => {
    const output = (demoResult?.stdout ?? '') + (demoResult?.stderr ?? '');
    assert.match(output, /Block Run Report/);
  });

  test('demo report output includes completed block status', () => {
    const output = (demoResult?.stdout ?? '') + (demoResult?.stderr ?? '');
    assert.match(output, /Status:\s+completed/);
  });

  test('demo report output includes task_1', () => {
    const output = (demoResult?.stdout ?? '') + (demoResult?.stderr ?? '');
    assert.match(output, /task_1/);
  });

  test('demo report output includes task_2', () => {
    const output = (demoResult?.stdout ?? '') + (demoResult?.stderr ?? '');
    assert.match(output, /task_2/);
  });

  test('demo report output does not leak fake demo secret', () => {
    const output = (demoResult?.stdout ?? '') + (demoResult?.stderr ?? '');
    assert.doesNotMatch(output, /sk-demo-placeholder/);
  });

  test('demo does not create files in project root', () => {
    const entries = readdirSync(PROJECT_ROOT);
    for (const entry of entries) {
      if (entry === 'node_modules' || entry === '.git' || entry === 'tmp' || entry === 'runs') {
        continue;
      }
      const fullPath = join(PROJECT_ROOT, entry);
      const stats = statSync(fullPath);
      if (stats.isDirectory()) {
        continue;
      }
      assert.ok(
        ['package.json', 'package-lock.json', 'tsconfig.json', '.env', '.env.example', '.gitignore']
          .includes(entry) ||
          entry.endsWith('.md') ||
          entry.endsWith('.yaml') ||
          entry.endsWith('.yml') ||
          entry.endsWith('.log'),
        `Unexpected file in project root: ${entry}`
      );
    }
  });

  test('cleanup demo artifacts', () => {
    if (tempDir && existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
    assert.ok(true);
  });
});

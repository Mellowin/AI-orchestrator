import { describe, test } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { runRealRepoSandboxPreflight } from '../src/real-repo-sandbox-preflight.js';

let counter = 0;

function makeId(): string {
  return `${Date.now()}-${counter++}`;
}

function createSourceRepo(): { repoPath: string; cleanup: () => void } {
  const id = makeId();
  const tmpBase = join(process.cwd(), 'tmp');
  if (!existsSync(tmpBase)) {
    mkdirSync(tmpBase);
  }
  const tmpDir = mkdtempSync(join(tmpBase, `preflight-source-${id}-`));
  const repoPath = join(tmpDir, 'repo');
  mkdirSync(repoPath);
  mkdirSync(join(repoPath, 'src'), { recursive: true });
  writeFileSync(join(repoPath, 'README.md'), '# hello\n', 'utf-8');
  writeFileSync(
    join(repoPath, 'src', 'index.ts'),
    'export const a = 1;\n',
    'utf-8'
  );
  mkdirSync(join(repoPath, '.git'), { recursive: true });
  writeFileSync(
    join(repoPath, '.git', 'HEAD'),
    'ref: refs/heads/main\n',
    'utf-8'
  );

  return {
    repoPath,
    cleanup: () => {
      rmSync(tmpDir, { recursive: true, force: true });
    },
  };
}

function createRealGitSourceRepo(): {
  repoPath: string;
  cleanup: () => void;
} {
  const id = makeId();
  const tmpBase = join(process.cwd(), 'tmp');
  if (!existsSync(tmpBase)) {
    mkdirSync(tmpBase);
  }
  const tmpDir = mkdtempSync(join(tmpBase, `preflight-real-git-${id}-`));
  const repoPath = join(tmpDir, 'repo');
  mkdirSync(repoPath);
  mkdirSync(join(repoPath, 'src'), { recursive: true });
  writeFileSync(join(repoPath, 'README.md'), '# hello\n', 'utf-8');
  writeFileSync(
    join(repoPath, 'src', 'index.ts'),
    'export const a = 1;\n',
    'utf-8'
  );

  function git(args: string[]): void {
    const result = spawnSync('git', args, {
      cwd: repoPath,
      encoding: 'utf-8',
      shell: false,
    });
    if (result.status !== 0) {
      throw new Error(
        `git ${args.join(' ')} failed: ${result.stderr || result.stdout || 'unknown'}`
      );
    }
  }

  git(['init']);
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'Test User']);
  git(['add', '-A']);
  git(['commit', '-m', 'base']);

  return {
    repoPath,
    cleanup: () => {
      rmSync(tmpDir, { recursive: true, force: true });
    },
  };
}

function createSandboxRoot(): { sandboxRoot: string; cleanup: () => void } {
  const id = makeId();
  const tmpBase = join(process.cwd(), 'tmp');
  if (!existsSync(tmpBase)) {
    mkdirSync(tmpBase);
  }
  const tmpDir = mkdtempSync(join(tmpBase, `preflight-sandbox-${id}-`));
  const sandboxRoot = join(tmpDir, 'root');
  mkdirSync(sandboxRoot);
  return {
    sandboxRoot,
    cleanup: () => {
      rmSync(tmpDir, { recursive: true, force: true });
    },
  };
}

function validRawProvider(files: Array<{ path: string; content: string }>): string {
  return `
\`\`\`json
${JSON.stringify({ mode: 'file_update', files })}
\`\`\`
`;
}

function baseTask(checks: Array<{ command: string; args: string[] }>) {
  return {
    id: 'test-task',
    title: 'Test',
    repo_path: '',
    base_branch: 'main',
    work_branch: 'work',
    goal: 'test',
    context_files: [],
    checks,
    guardrails: {
      deny_modify: [],
      auto_commit: false,
      auto_push: false,
      auto_merge: false,
    },
  };
}

describe('runRealRepoSandboxPreflight', () => {
  test('returns ok:true when sandbox flow succeeds', () => {
    const { repoPath, cleanup: cleanupSource } = createSourceRepo();
    const { sandboxRoot, cleanup: cleanupSandboxRoot } = createSandboxRoot();
    try {
      const task = {
        ...baseTask([{ command: 'node', args: ['-e', 'process.exit(0)'] }]),
        repo_path: repoPath,
      };
      const raw = validRawProvider([{ path: 'README.md', content: '# updated\n' }]);

      const result = runRealRepoSandboxPreflight({ task, rawProviderText: raw, sandboxRoot });

      assert.strictEqual(result.ok, true);
      assert.deepStrictEqual(result.appliedFiles, ['README.md']);
      assert.ok(result.logs.includes('step: checks'));
    } finally {
      cleanupSource();
      cleanupSandboxRoot();
    }
  });

  test('returns ok:false when sandbox flow fails', () => {
    const { repoPath, cleanup: cleanupSource } = createSourceRepo();
    const { sandboxRoot, cleanup: cleanupSandboxRoot } = createSandboxRoot();
    try {
      const task = {
        ...baseTask([{ command: 'node', args: ['-e', 'process.exit(1)'] }]),
        repo_path: repoPath,
      };
      const raw = validRawProvider([{ path: 'README.md', content: '# updated\n' }]);

      const result = runRealRepoSandboxPreflight({ task, rawProviderText: raw, sandboxRoot });

      assert.strictEqual(result.ok, false);
    } finally {
      cleanupSource();
      cleanupSandboxRoot();
    }
  });

  test('preserves failedStep on failure', () => {
    const { repoPath, cleanup: cleanupSource } = createSourceRepo();
    const { sandboxRoot, cleanup: cleanupSandboxRoot } = createSandboxRoot();
    try {
      const task = {
        ...baseTask([]),
        repo_path: repoPath,
      };
      const raw = 'not-json-at-all';

      const result = runRealRepoSandboxPreflight({ task, rawProviderText: raw, sandboxRoot });

      assert.strictEqual(result.ok, false);
      assert.strictEqual(result.failedStep, 'parse');
    } finally {
      cleanupSource();
      cleanupSandboxRoot();
    }
  });

  test('preserves logs', () => {
    const { repoPath, cleanup: cleanupSource } = createSourceRepo();
    const { sandboxRoot, cleanup: cleanupSandboxRoot } = createSandboxRoot();
    try {
      const task = {
        ...baseTask([{ command: 'node', args: ['-e', 'process.exit(0)'] }]),
        repo_path: repoPath,
      };
      const raw = validRawProvider([{ path: 'README.md', content: '# updated\n' }]);

      const result = runRealRepoSandboxPreflight({ task, rawProviderText: raw, sandboxRoot });

      assert.ok(result.logs.length > 0);
      assert.ok(result.logs.includes('step: parse'));
      assert.ok(result.logs.includes('step: guardrails'));
    } finally {
      cleanupSource();
      cleanupSandboxRoot();
    }
  });

  test('preserves appliedFiles on success', () => {
    const { repoPath, cleanup: cleanupSource } = createSourceRepo();
    const { sandboxRoot, cleanup: cleanupSandboxRoot } = createSandboxRoot();
    try {
      const task = {
        ...baseTask([{ command: 'node', args: ['-e', 'process.exit(0)'] }]),
        repo_path: repoPath,
      };
      const raw = validRawProvider([{ path: 'README.md', content: '# updated\n' }]);

      const result = runRealRepoSandboxPreflight({ task, rawProviderText: raw, sandboxRoot });

      assert.strictEqual(result.ok, true);
      assert.deepStrictEqual(result.appliedFiles, ['README.md']);
    } finally {
      cleanupSource();
      cleanupSandboxRoot();
    }
  });

  test('does not mutate the real repo', () => {
    const { repoPath, cleanup: cleanupSource } = createSourceRepo();
    const { sandboxRoot, cleanup: cleanupSandboxRoot } = createSandboxRoot();
    try {
      const original = readFileSync(join(repoPath, 'README.md'), 'utf-8');
      const task = {
        ...baseTask([{ command: 'node', args: ['-e', 'process.exit(0)'] }]),
        repo_path: repoPath,
      };
      const raw = validRawProvider([{ path: 'README.md', content: '# mutated\n' }]);

      runRealRepoSandboxPreflight({ task, rawProviderText: raw, sandboxRoot });

      assert.strictEqual(readFileSync(join(repoPath, 'README.md'), 'utf-8'), original);
    } finally {
      cleanupSource();
      cleanupSandboxRoot();
    }
  });

  test('no provider call is made', () => {
    const { repoPath, cleanup: cleanupSource } = createSourceRepo();
    const { sandboxRoot, cleanup: cleanupSandboxRoot } = createSandboxRoot();
    try {
      const task = {
        ...baseTask([{ command: 'node', args: ['-e', 'process.exit(0)'] }]),
        repo_path: repoPath,
      };
      const raw = validRawProvider([{ path: 'README.md', content: '# updated\n' }]);

      // If any provider call were attempted, it would throw or require env keys.
      const result = runRealRepoSandboxPreflight({ task, rawProviderText: raw, sandboxRoot });

      assert.strictEqual(result.ok, true);
    } finally {
      cleanupSource();
      cleanupSandboxRoot();
    }
  });

  test('passes git diff --check when preserveGit copies the real repo', () => {
    const { repoPath, cleanup: cleanupSource } = createRealGitSourceRepo();
    const { sandboxRoot, cleanup: cleanupSandboxRoot } = createSandboxRoot();
    try {
      const task = {
        ...baseTask([{ command: 'git', args: ['diff', '--check'] }]),
        repo_path: repoPath,
      };
      const raw = validRawProvider([
        { path: 'README.md', content: '# hello\n\nUpdated description.\n' },
      ]);

      const result = runRealRepoSandboxPreflight({
        task,
        rawProviderText: raw,
        sandboxRoot,
      });

      assert.strictEqual(result.ok, true, `Expected ok true, logs:\n${result.logs}`);
      assert.ok(result.logs.includes('step: checks'));
    } finally {
      cleanupSource();
      cleanupSandboxRoot();
    }
  });
});

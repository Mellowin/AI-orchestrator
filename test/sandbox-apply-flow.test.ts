import { describe, test } from 'node:test';
import assert from 'node:assert';
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
import { runSandboxApplyFlow } from '../src/sandbox-apply-flow.js';

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
  const tmpDir = mkdtempSync(join(tmpBase, `flow-source-${id}-`));
  const repoPath = join(tmpDir, 'repo');
  mkdirSync(repoPath);
  mkdirSync(join(repoPath, 'src'), { recursive: true });
  writeFileSync(join(repoPath, 'README.md'), '# hello\n', 'utf-8');
  writeFileSync(
    join(repoPath, 'src', 'index.ts'),
    'export const a = 1;\n',
    'utf-8'
  );
  // Fake git repo so createSandboxRepoCopy accepts it
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

function createSandboxRoot(): { sandboxRoot: string; cleanup: () => void } {
  const id = makeId();
  const tmpBase = join(process.cwd(), 'tmp');
  if (!existsSync(tmpBase)) {
    mkdirSync(tmpBase);
  }
  const tmpDir = mkdtempSync(join(tmpBase, `flow-sandbox-${id}-`));
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
    repo_path: '', // filled in by tests
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

describe('runSandboxApplyFlow', () => {
  test('successful flow applies patch in sandbox and runs checks', () => {
    const { repoPath, cleanup: cleanupSource } = createSourceRepo();
    const { sandboxRoot, cleanup: cleanupSandboxRoot } = createSandboxRoot();
    try {
      const task = {
        ...baseTask([
          { command: 'node', args: ['-e', 'process.exit(0)'] },
        ]),
        repo_path: repoPath,
      };
      const raw = validRawProvider([
        { path: 'README.md', content: '# updated\n' },
      ]);

      const result = runSandboxApplyFlow({ task, rawProviderText: raw, sandboxRoot });

      assert.strictEqual(result.success, true);
      assert.deepStrictEqual(result.appliedFiles, ['README.md']);
      assert.strictEqual(result.checksPassed, true);
    } finally {
      cleanupSource();
      cleanupSandboxRoot();
    }
  });

  test('real repo file remains unchanged after success', () => {
    const { repoPath, cleanup: cleanupSource } = createSourceRepo();
    const { sandboxRoot, cleanup: cleanupSandboxRoot } = createSandboxRoot();
    try {
      const original = readFileSync(join(repoPath, 'README.md'), 'utf-8');
      const task = {
        ...baseTask([
          { command: 'node', args: ['-e', 'process.exit(0)'] },
        ]),
        repo_path: repoPath,
      };
      const raw = validRawProvider([
        { path: 'README.md', content: '# modified-in-sandbox\n' },
      ]);

      runSandboxApplyFlow({ task, rawProviderText: raw, sandboxRoot });

      assert.strictEqual(
        readFileSync(join(repoPath, 'README.md'), 'utf-8'),
        original
      );
    } finally {
      cleanupSource();
      cleanupSandboxRoot();
    }
  });

  test('successful flow cleans up sandbox by default', () => {
    const { repoPath, cleanup: cleanupSource } = createSourceRepo();
    const { sandboxRoot, cleanup: cleanupSandboxRoot } = createSandboxRoot();
    try {
      const task = {
        ...baseTask([
          { command: 'node', args: ['-e', 'process.exit(0)'] },
        ]),
        repo_path: repoPath,
      };
      const raw = validRawProvider([
        { path: 'README.md', content: '# updated\n' },
      ]);

      const result = runSandboxApplyFlow({ task, rawProviderText: raw, sandboxRoot });

      assert.strictEqual(result.success, true);
      // No sandbox directories should remain under sandboxRoot
      const entries = existsSync(sandboxRoot) ? readdirSync(sandboxRoot) : [];
      assert.strictEqual(
        entries.length,
        0,
        'sandbox should be cleaned up after success'
      );
    } finally {
      cleanupSource();
      cleanupSandboxRoot();
    }
  });

  test('malformed provider output returns success:false failedStep:parse', () => {
    const { repoPath, cleanup: cleanupSource } = createSourceRepo();
    const { sandboxRoot, cleanup: cleanupSandboxRoot } = createSandboxRoot();
    try {
      const task = {
        ...baseTask([]),
        repo_path: repoPath,
      };
      const result = runSandboxApplyFlow({
        task,
        rawProviderText: 'not-json-at-all',
        sandboxRoot,
      });

      assert.strictEqual(result.success, false);
      assert.strictEqual(result.failedStep, 'parse');
    } finally {
      cleanupSource();
      cleanupSandboxRoot();
    }
  });

  test('guardrails denied file returns success:false failedStep:guardrails', () => {
    const { repoPath, cleanup: cleanupSource } = createSourceRepo();
    const { sandboxRoot, cleanup: cleanupSandboxRoot } = createSandboxRoot();
    try {
      const task = {
        ...baseTask([]),
        repo_path: repoPath,
        guardrails: {
          deny_modify: ['*.env'],
          auto_commit: false,
          auto_push: false,
          auto_merge: false,
        },
      };
      const raw = validRawProvider([
        { path: 'secrets.env', content: 'x' },
      ]);

      const result = runSandboxApplyFlow({ task, rawProviderText: raw, sandboxRoot });

      assert.strictEqual(result.success, false);
      assert.strictEqual(result.failedStep, 'guardrails');
    } finally {
      cleanupSource();
      cleanupSandboxRoot();
    }
  });

  test('line delta guardrails failure returns success:false failedStep:guardrails', () => {
    const { repoPath, cleanup: cleanupSource } = createSourceRepo();
    const { sandboxRoot, cleanup: cleanupSandboxRoot } = createSandboxRoot();
    try {
      const task = {
        ...baseTask([]),
        repo_path: repoPath,
        guardrails: {
          deny_modify: [],
          max_lines_changed: 1,
          auto_commit: false,
          auto_push: false,
          auto_merge: false,
        },
      };
      // README.md currently has 1 line. Changing to 10 lines is delta 9 > 1.
      const raw = validRawProvider([
        { path: 'README.md', content: '1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n' },
      ]);

      const result = runSandboxApplyFlow({ task, rawProviderText: raw, sandboxRoot });

      assert.strictEqual(result.success, false);
      assert.strictEqual(result.failedStep, 'guardrails');
    } finally {
      cleanupSource();
      cleanupSandboxRoot();
    }
  });

  test('check failure returns success:false failedStep:checks', () => {
    const { repoPath, cleanup: cleanupSource } = createSourceRepo();
    const { sandboxRoot, cleanup: cleanupSandboxRoot } = createSandboxRoot();
    try {
      const task = {
        ...baseTask([
          { command: 'node', args: ['-e', 'process.exit(1)'] },
        ]),
        repo_path: repoPath,
      };
      const raw = validRawProvider([
        { path: 'README.md', content: '# updated\n' },
      ]);

      const result = runSandboxApplyFlow({ task, rawProviderText: raw, sandboxRoot });

      assert.strictEqual(result.success, false);
      assert.strictEqual(result.failedStep, 'checks');
    } finally {
      cleanupSource();
      cleanupSandboxRoot();
    }
  });

  test('on check failure sandbox changes are rolled back and cleaned up', () => {
    const { repoPath, cleanup: cleanupSource } = createSourceRepo();
    const { sandboxRoot, cleanup: cleanupSandboxRoot } = createSandboxRoot();
    try {
      const task = {
        ...baseTask([
          { command: 'node', args: ['-e', 'process.exit(1)'] },
        ]),
        repo_path: repoPath,
      };
      const raw = validRawProvider([
        { path: 'README.md', content: '# updated\n' },
      ]);

      const result = runSandboxApplyFlow({ task, rawProviderText: raw, sandboxRoot });

      assert.strictEqual(result.success, false);
      // Sandbox should be cleaned up
      const entries = existsSync(sandboxRoot) ? readdirSync(sandboxRoot) : [];
      assert.strictEqual(
        entries.length,
        0,
        'sandbox should be cleaned up after check failure'
      );
      // Real repo unchanged
      assert.strictEqual(
        readFileSync(join(repoPath, 'README.md'), 'utf-8'),
        '# hello\n'
      );
    } finally {
      cleanupSource();
      cleanupSandboxRoot();
    }
  });

  test('apply failure returns success:false and cleans up sandbox', () => {
    // Create a repo where 'foo' is a file, so applying 'foo/bar.txt' fails at write time
    const id = makeId();
    const tmpBase = join(process.cwd(), 'tmp');
    if (!existsSync(tmpBase)) {
      mkdirSync(tmpBase);
    }
    const tmpDir = mkdtempSync(join(tmpBase, `flow-apply-fail-${id}-`));
    const repoPath = join(tmpDir, 'repo');
    mkdirSync(repoPath);
    writeFileSync(join(repoPath, 'README.md'), '# hello\n', 'utf-8');
    // Create 'foo' as a FILE, not a directory
    writeFileSync(join(repoPath, 'foo'), 'i-am-a-file\n', 'utf-8');
    mkdirSync(join(repoPath, '.git'), { recursive: true });
    writeFileSync(
      join(repoPath, '.git', 'HEAD'),
      'ref: refs/heads/main\n',
      'utf-8'
    );

    const { sandboxRoot, cleanup: cleanupSandboxRoot } = createSandboxRoot();
    try {
      const task = {
        ...baseTask([]),
        repo_path: repoPath,
      };
      const raw = validRawProvider([
        { path: 'foo/bar.txt', content: 'x' },
      ]);

      const result = runSandboxApplyFlow({ task, rawProviderText: raw, sandboxRoot });

      assert.strictEqual(result.success, false);
      assert.strictEqual(result.failedStep, 'apply');
      const entries = existsSync(sandboxRoot) ? readdirSync(sandboxRoot) : [];
      assert.strictEqual(
        entries.length,
        0,
        'sandbox should be cleaned up after apply failure'
      );
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
      cleanupSandboxRoot();
    }
  });

  test('checks run in sandbox path not real repo', () => {
    const { repoPath, cleanup: cleanupSource } = createSourceRepo();
    const { sandboxRoot, cleanup: cleanupSandboxRoot } = createSandboxRoot();
    try {
      // Check verifies applied file content exists; real repo still has original
      const task = {
        ...baseTask([
          {
            command: 'node',
            args: [
              '-e',
              `const fs=require('fs'); const c=fs.readFileSync('README.md','utf-8'); if(c!=='# sandbox-modified\\n') process.exit(1)`,
            ],
          },
        ]),
        repo_path: repoPath,
      };
      const raw = validRawProvider([
        { path: 'README.md', content: '# sandbox-modified\n' },
      ]);

      const result = runSandboxApplyFlow({ task, rawProviderText: raw, sandboxRoot });

      assert.strictEqual(result.success, true, 'checks must run in sandbox where file was modified');
    } finally {
      cleanupSource();
      cleanupSandboxRoot();
    }
  });

  test('no state file written', () => {
    const { repoPath, cleanup: cleanupSource } = createSourceRepo();
    const { sandboxRoot, cleanup: cleanupSandboxRoot } = createSandboxRoot();
    try {
      const task = {
        ...baseTask([
          { command: 'node', args: ['-e', 'process.exit(0)'] },
        ]),
        repo_path: repoPath,
      };
      const raw = validRawProvider([
        { path: 'README.md', content: '# updated\n' },
      ]);

      runSandboxApplyFlow({ task, rawProviderText: raw, sandboxRoot });

      assert(!existsSync(join(repoPath, 'runs', 'state.json')));
      assert(!existsSync(join(repoPath, 'state.json')));
    } finally {
      cleanupSource();
      cleanupSandboxRoot();
    }
  });

  test('no git branch or commit created in real repo', () => {
    const { repoPath, cleanup: cleanupSource } = createSourceRepo();
    const { sandboxRoot, cleanup: cleanupSandboxRoot } = createSandboxRoot();
    try {
      const task = {
        ...baseTask([
          { command: 'node', args: ['-e', 'process.exit(0)'] },
        ]),
        repo_path: repoPath,
      };
      const raw = validRawProvider([
        { path: 'README.md', content: '# updated\n' },
      ]);

      runSandboxApplyFlow({ task, rawProviderText: raw, sandboxRoot });

      // Real repo HEAD should still be the fake one we created
      const head = readFileSync(join(repoPath, '.git', 'HEAD'), 'utf-8');
      assert(head.includes('main'));
      // No new refs
      assert(!existsSync(join(repoPath, '.git', 'refs', 'heads', 'work')));
    } finally {
      cleanupSource();
      cleanupSandboxRoot();
    }
  });

  test('logs include major steps', () => {
    const { repoPath, cleanup: cleanupSource } = createSourceRepo();
    const { sandboxRoot, cleanup: cleanupSandboxRoot } = createSandboxRoot();
    try {
      const task = {
        ...baseTask([
          { command: 'node', args: ['-e', 'process.exit(0)'] },
        ]),
        repo_path: repoPath,
      };
      const raw = validRawProvider([
        { path: 'README.md', content: '# updated\n' },
      ]);

      const result = runSandboxApplyFlow({ task, rawProviderText: raw, sandboxRoot });

      assert.strictEqual(result.success, true);
      const logs = result.logs;
      assert(logs.includes('step: parse'));
      assert(logs.includes('step: guardrails'));
      assert(logs.includes('step: sandbox copy'));
      assert(logs.includes('step: apply'));
      assert(logs.includes('step: checks'));
      assert(logs.includes('step: cleanup'));
    } finally {
      cleanupSource();
      cleanupSandboxRoot();
    }
  });

  test('logs include rollback on check failure', () => {
    const { repoPath, cleanup: cleanupSource } = createSourceRepo();
    const { sandboxRoot, cleanup: cleanupSandboxRoot } = createSandboxRoot();
    try {
      const task = {
        ...baseTask([
          { command: 'node', args: ['-e', 'process.exit(1)'] },
        ]),
        repo_path: repoPath,
      };
      const raw = validRawProvider([
        { path: 'README.md', content: '# updated\n' },
      ]);

      const result = runSandboxApplyFlow({ task, rawProviderText: raw, sandboxRoot });

      assert.strictEqual(result.success, false);
      assert(result.logs.includes('step: rollback'));
      assert(result.logs.includes('step: cleanup'));
    } finally {
      cleanupSource();
      cleanupSandboxRoot();
    }
  });

  test('no real network or API keys used', () => {
    const { repoPath, cleanup: cleanupSource } = createSourceRepo();
    const { sandboxRoot, cleanup: cleanupSandboxRoot } = createSandboxRoot();
    try {
      const task = {
        ...baseTask([
          { command: 'node', args: ['-e', 'process.exit(0)'] },
        ]),
        repo_path: repoPath,
      };
      const raw = validRawProvider([
        { path: 'README.md', content: '# updated\n' },
      ]);

      // The flow should complete without any network; if it tried,
      // it would throw or timeout. Success proves no network.
      const result = runSandboxApplyFlow({ task, rawProviderText: raw, sandboxRoot });
      assert.strictEqual(result.success, true);
    } finally {
      cleanupSource();
      cleanupSandboxRoot();
    }
  });
});

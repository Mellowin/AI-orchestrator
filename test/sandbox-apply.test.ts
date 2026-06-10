import { describe, test } from 'node:test';
import assert from 'node:assert';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { applyToSandboxRepo } from '../src/sandbox-apply.js';

let counter = 0;

function createSandbox(): {
  sandboxRepoPath: string;
  cleanup: () => void;
} {
  const id = `${Date.now()}-${counter++}`;
  const tmpBase = join(process.cwd(), 'tmp');
  if (!existsSync(tmpBase)) {
    mkdirSync(tmpBase);
  }
  const tmpDir = mkdtempSync(join(tmpBase, `sandbox-apply-${id}-`));
  const sandboxRepoPath = join(tmpDir, 'repo');
  mkdirSync(sandboxRepoPath);
  mkdirSync(join(sandboxRepoPath, 'src'), { recursive: true });
  writeFileSync(join(sandboxRepoPath, 'README.md'), '# hello\n', 'utf-8');
  writeFileSync(
    join(sandboxRepoPath, 'src', 'index.ts'),
    'export const a = 1;\n',
    'utf-8'
  );

  return {
    sandboxRepoPath,
    cleanup: () => {
      rmSync(tmpDir, { recursive: true, force: true });
    },
  };
}

describe('applyToSandboxRepo', () => {
  test('applies update to existing file in sandbox', () => {
    const { sandboxRepoPath, cleanup } = createSandbox();
    try {
      const result = applyToSandboxRepo(sandboxRepoPath, [
        { path: 'README.md', content: '# updated\n' },
      ]);
      assert.deepStrictEqual(result.appliedFiles, ['README.md']);
      assert.strictEqual(
        readFileSync(join(sandboxRepoPath, 'README.md'), 'utf-8'),
        '# updated\n'
      );
      result.rollback();
    } finally {
      cleanup();
    }
  });

  test('creates new file in sandbox', () => {
    const { sandboxRepoPath, cleanup } = createSandbox();
    try {
      const result = applyToSandboxRepo(sandboxRepoPath, [
        { path: 'new.ts', content: 'const x = 1;\n' },
      ]);
      assert.deepStrictEqual(result.appliedFiles, ['new.ts']);
      assert(existsSync(join(sandboxRepoPath, 'new.ts')));
      result.rollback();
    } finally {
      cleanup();
    }
  });

  test('creates nested directories', () => {
    const { sandboxRepoPath, cleanup } = createSandbox();
    try {
      const result = applyToSandboxRepo(sandboxRepoPath, [
        { path: 'src/utils/helper.ts', content: 'export const h = 1;\n' },
      ]);
      assert(
        existsSync(join(sandboxRepoPath, 'src', 'utils', 'helper.ts'))
      );
      result.rollback();
    } finally {
      cleanup();
    }
  });

  test('rollback restores overwritten file', () => {
    const { sandboxRepoPath, cleanup } = createSandbox();
    try {
      const original = readFileSync(
        join(sandboxRepoPath, 'README.md'),
        'utf-8'
      );
      const result = applyToSandboxRepo(sandboxRepoPath, [
        { path: 'README.md', content: '# modified\n' },
      ]);
      assert.strictEqual(
        readFileSync(join(sandboxRepoPath, 'README.md'), 'utf-8'),
        '# modified\n'
      );
      result.rollback();
      assert.strictEqual(
        readFileSync(join(sandboxRepoPath, 'README.md'), 'utf-8'),
        original
      );
    } finally {
      cleanup();
    }
  });

  test('rollback removes newly created file', () => {
    const { sandboxRepoPath, cleanup } = createSandbox();
    try {
      const result = applyToSandboxRepo(sandboxRepoPath, [
        { path: 'new.ts', content: 'const x = 1;\n' },
      ]);
      assert(existsSync(join(sandboxRepoPath, 'new.ts')));
      result.rollback();
      assert(!existsSync(join(sandboxRepoPath, 'new.ts')));
    } finally {
      cleanup();
    }
  });

  test('rejects absolute path', () => {
    const { sandboxRepoPath, cleanup } = createSandbox();
    try {
      assert.throws(
        () =>
          applyToSandboxRepo(sandboxRepoPath, [
            { path: '/etc/passwd', content: 'x' },
          ]),
        /Absolute/
      );
    } finally {
      cleanup();
    }
  });

  test('rejects path traversal', () => {
    const { sandboxRepoPath, cleanup } = createSandbox();
    try {
      assert.throws(
        () =>
          applyToSandboxRepo(sandboxRepoPath, [
            { path: '../escape', content: 'x' },
          ]),
        /traversal|escapes/
      );
    } finally {
      cleanup();
    }
  });

  test('rejects backslash path', () => {
    const { sandboxRepoPath, cleanup } = createSandbox();
    try {
      assert.throws(
        () =>
          applyToSandboxRepo(sandboxRepoPath, [
            { path: 'src\\file.ts', content: 'x' },
          ]),
        /Backslash/
      );
    } finally {
      cleanup();
    }
  });

  test('rejects invalid/empty path', () => {
    const { sandboxRepoPath, cleanup } = createSandbox();
    try {
      assert.throws(
        () =>
          applyToSandboxRepo(sandboxRepoPath, [
            { path: '', content: 'x' },
          ]),
        /empty/
      );
    } finally {
      cleanup();
    }
  });

  test('throws when sandboxRepoPath does not exist', () => {
    assert.throws(
      () =>
        applyToSandboxRepo(
          join(process.cwd(), 'tmp', 'nonexistent-sandbox'),
          []
        ),
      /does not exist/
    );
  });

  test('on failure mid-apply, previous changes are rolled back', () => {
    const { sandboxRepoPath, cleanup } = createSandbox();
    try {
      const original = readFileSync(
        join(sandboxRepoPath, 'README.md'),
        'utf-8'
      );
      assert.throws(() =>
        applyToSandboxRepo(sandboxRepoPath, [
          { path: 'README.md', content: '# first\n' },
          { path: '../escape', content: 'x' },
        ])
      );
      assert.strictEqual(
        readFileSync(join(sandboxRepoPath, 'README.md'), 'utf-8'),
        original
      );
    } finally {
      cleanup();
    }
  });

  test('does not modify files outside sandboxRepoPath', () => {
    const id = `${Date.now()}-${counter++}`;
    const tmpBase = join(process.cwd(), 'tmp');
    if (!existsSync(tmpBase)) {
      mkdirSync(tmpBase);
    }
    const tmpDir = mkdtempSync(
      join(tmpBase, `sandbox-apply-outside-${id}-`)
    );
    const sandboxRepoPath = join(tmpDir, 'repo');
    const outsidePath = join(tmpDir, 'outside');
    mkdirSync(sandboxRepoPath);
    mkdirSync(outsidePath);
    writeFileSync(join(outsidePath, 'file.txt'), 'outside\n', 'utf-8');

    try {
      applyToSandboxRepo(sandboxRepoPath, [
        { path: 'README.md', content: '# inside\n' },
      ]);
      assert.strictEqual(
        readFileSync(join(outsidePath, 'file.txt'), 'utf-8'),
        'outside\n'
      );
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('does not create git branch or commit', () => {
    const { sandboxRepoPath, cleanup } = createSandbox();
    try {
      applyToSandboxRepo(sandboxRepoPath, [
        { path: 'README.md', content: '# updated\n' },
      ]);
      assert(
        !existsSync(join(sandboxRepoPath, '.git')),
        'no .git should exist'
      );
    } finally {
      cleanup();
    }
  });

  test('does not write runs/state.json', () => {
    const { sandboxRepoPath, cleanup } = createSandbox();
    try {
      applyToSandboxRepo(sandboxRepoPath, [
        { path: 'README.md', content: '# updated\n' },
      ]);
      assert(
        !existsSync(join(sandboxRepoPath, 'runs')),
        'no runs dir should be created'
      );
    } finally {
      cleanup();
    }
  });
});

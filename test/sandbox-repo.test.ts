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
import { createSandboxRepoCopy } from '../src/sandbox-repo.js';

let counter = 0;

function createTempDirs(): {
  sourceRepo: string;
  sandboxRoot: string;
  cleanup: () => void;
} {
  const id = `${Date.now()}-${counter++}`;
  const tmpBase = join(process.cwd(), 'tmp');
  if (!existsSync(tmpBase)) {
    mkdirSync(tmpBase);
  }
  const tmpDir = mkdtempSync(join(tmpBase, `sandbox-test-${id}-`));
  const sourceRepo = join(tmpDir, 'source-repo');
  const sandboxRoot = join(tmpDir, 'sandbox-root');
  mkdirSync(sourceRepo);
  mkdirSync(sandboxRoot);

  mkdirSync(join(sourceRepo, 'src'), { recursive: true });
  writeFileSync(join(sourceRepo, 'README.md'), '# test\n', 'utf-8');
  writeFileSync(join(sourceRepo, 'src', 'index.ts'), 'export const x = 1;\n', 'utf-8');
  writeFileSync(join(sourceRepo, '.env'), 'SECRET=1\n', 'utf-8');
  writeFileSync(join(sourceRepo, '.env.local'), 'LOCAL=1\n', 'utf-8');
  mkdirSync(join(sourceRepo, 'node_modules'), { recursive: true });
  writeFileSync(
    join(sourceRepo, 'node_modules', 'foo.js'),
    'module.exports = 1;\n',
    'utf-8'
  );
  mkdirSync(join(sourceRepo, 'runs'), { recursive: true });
  writeFileSync(join(sourceRepo, 'runs', 'state.json'), '{}', 'utf-8');
  mkdirSync(join(sourceRepo, '.git'), { recursive: true });
  writeFileSync(
    join(sourceRepo, '.git', 'HEAD'),
    'ref: refs/heads/main\n',
    'utf-8'
  );

  return {
    sourceRepo,
    sandboxRoot,
    cleanup: () => {
      rmSync(tmpDir, { recursive: true, force: true });
    },
  };
}

describe('createSandboxRepoCopy', () => {
  test('copies normal files from source repo to sandbox', () => {
    const { sourceRepo, sandboxRoot, cleanup } = createTempDirs();
    try {
      const { sandboxRepoPath, cleanup: sandboxCleanup } = createSandboxRepoCopy(
        sourceRepo,
        sandboxRoot
      );
      try {
        assert(
          existsSync(join(sandboxRepoPath, 'README.md')),
          'README.md should be copied'
        );
        assert.strictEqual(
          readFileSync(join(sandboxRepoPath, 'README.md'), 'utf-8'),
          '# test\n'
        );
      } finally {
        sandboxCleanup();
      }
    } finally {
      cleanup();
    }
  });

  test('copies nested directories', () => {
    const { sourceRepo, sandboxRoot, cleanup } = createTempDirs();
    try {
      const { sandboxRepoPath, cleanup: sandboxCleanup } = createSandboxRepoCopy(
        sourceRepo,
        sandboxRoot
      );
      try {
        assert(
          existsSync(join(sandboxRepoPath, 'src', 'index.ts')),
          'src/index.ts should be copied'
        );
        assert.strictEqual(
          readFileSync(join(sandboxRepoPath, 'src', 'index.ts'), 'utf-8'),
          'export const x = 1;\n'
        );
      } finally {
        sandboxCleanup();
      }
    } finally {
      cleanup();
    }
  });

  test('excludes .git', () => {
    const { sourceRepo, sandboxRoot, cleanup } = createTempDirs();
    try {
      const { sandboxRepoPath, cleanup: sandboxCleanup } = createSandboxRepoCopy(
        sourceRepo,
        sandboxRoot
      );
      try {
        assert(
          !existsSync(join(sandboxRepoPath, '.git')),
          '.git should be excluded'
        );
      } finally {
        sandboxCleanup();
      }
    } finally {
      cleanup();
    }
  });

  test('excludes node_modules', () => {
    const { sourceRepo, sandboxRoot, cleanup } = createTempDirs();
    try {
      const { sandboxRepoPath, cleanup: sandboxCleanup } = createSandboxRepoCopy(
        sourceRepo,
        sandboxRoot
      );
      try {
        assert(
          !existsSync(join(sandboxRepoPath, 'node_modules')),
          'node_modules should be excluded'
        );
      } finally {
        sandboxCleanup();
      }
    } finally {
      cleanup();
    }
  });

  test('excludes runs', () => {
    const { sourceRepo, sandboxRoot, cleanup } = createTempDirs();
    try {
      const { sandboxRepoPath, cleanup: sandboxCleanup } = createSandboxRepoCopy(
        sourceRepo,
        sandboxRoot
      );
      try {
        assert(
          !existsSync(join(sandboxRepoPath, 'runs')),
          'runs should be excluded'
        );
      } finally {
        sandboxCleanup();
      }
    } finally {
      cleanup();
    }
  });

  test('excludes .env and .env.local', () => {
    const { sourceRepo, sandboxRoot, cleanup } = createTempDirs();
    try {
      const { sandboxRepoPath, cleanup: sandboxCleanup } = createSandboxRepoCopy(
        sourceRepo,
        sandboxRoot
      );
      try {
        assert(
          !existsSync(join(sandboxRepoPath, '.env')),
          '.env should be excluded'
        );
        assert(
          !existsSync(join(sandboxRepoPath, '.env.local')),
          '.env.local should be excluded'
        );
      } finally {
        sandboxCleanup();
      }
    } finally {
      cleanup();
    }
  });

  test('source repo files remain unchanged', () => {
    const { sourceRepo, sandboxRoot, cleanup } = createTempDirs();
    try {
      const originalContent = readFileSync(
        join(sourceRepo, 'README.md'),
        'utf-8'
      );
      const { sandboxRepoPath, cleanup: sandboxCleanup } = createSandboxRepoCopy(
        sourceRepo,
        sandboxRoot
      );
      try {
        writeFileSync(
          join(sandboxRepoPath, 'README.md'),
          '# modified\n',
          'utf-8'
        );
      } finally {
        sandboxCleanup();
      }
      assert.strictEqual(
        readFileSync(join(sourceRepo, 'README.md'), 'utf-8'),
        originalContent,
        'Source repo should not be modified'
      );
    } finally {
      cleanup();
    }
  });

  test('cleanup removes sandbox directory', () => {
    const { sourceRepo, sandboxRoot, cleanup } = createTempDirs();
    try {
      const { sandboxRepoPath, cleanup: sandboxCleanup } = createSandboxRepoCopy(
        sourceRepo,
        sandboxRoot
      );
      assert(existsSync(sandboxRepoPath), 'Sandbox should exist before cleanup');
      sandboxCleanup();
      assert(
        !existsSync(sandboxRepoPath),
        'Sandbox should be removed after cleanup'
      );
    } finally {
      cleanup();
    }
  });

  test('cleanup does not remove sandboxRoot', () => {
    const { sourceRepo, sandboxRoot, cleanup } = createTempDirs();
    try {
      const { cleanup: sandboxCleanup } = createSandboxRepoCopy(
        sourceRepo,
        sandboxRoot
      );
      sandboxCleanup();
      assert(
        existsSync(sandboxRoot),
        'sandboxRoot should still exist after cleanup'
      );
    } finally {
      cleanup();
    }
  });

  test('throws when source repo does not exist', () => {
    const { sandboxRoot, cleanup } = createTempDirs();
    try {
      assert.throws(
        () => createSandboxRepoCopy(join(sandboxRoot, 'nonexistent'), sandboxRoot),
        /does not exist/
      );
    } finally {
      cleanup();
    }
  });

  test('throws when source path is not git repo', () => {
    const { sandboxRoot, cleanup } = createTempDirs();
    try {
      const notGitRepo = join(sandboxRoot, 'not-git');
      mkdirSync(notGitRepo);
      writeFileSync(join(notGitRepo, 'file.txt'), 'hello\n', 'utf-8');
      assert.throws(
        () => createSandboxRepoCopy(notGitRepo, sandboxRoot),
        /not a git repository/
      );
    } finally {
      cleanup();
    }
  });

  test('throws when sandboxRoot does not exist', () => {
    const { sourceRepo, cleanup } = createTempDirs();
    try {
      assert.throws(
        () => createSandboxRepoCopy(sourceRepo, join(sourceRepo, 'nonexistent')),
        /does not exist/
      );
    } finally {
      cleanup();
    }
  });

  test('does not run git or create branches', () => {
    const { sourceRepo, sandboxRoot, cleanup } = createTempDirs();
    try {
      const { sandboxRepoPath, cleanup: sandboxCleanup } = createSandboxRepoCopy(
        sourceRepo,
        sandboxRoot
      );
      try {
        assert(
          !existsSync(join(sandboxRepoPath, '.git')),
          '.git should be excluded, proving no git init was run'
        );
      } finally {
        sandboxCleanup();
      }
    } finally {
      cleanup();
    }
  });

  test('no state file written', () => {
    const { sourceRepo, sandboxRoot, cleanup } = createTempDirs();
    try {
      const { sandboxRepoPath, cleanup: sandboxCleanup } = createSandboxRepoCopy(
        sourceRepo,
        sandboxRoot
      );
      try {
        assert(
          !existsSync(join(sandboxRepoPath, 'runs')),
          'runs dir should be excluded'
        );
        assert(
          !existsSync(join(sandboxRepoPath, 'state.json')),
          'state.json should not exist'
        );
      } finally {
        sandboxCleanup();
      }
    } finally {
      cleanup();
    }
  });
});

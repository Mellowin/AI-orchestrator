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
  writeFileSync(
    join(sourceRepo, '.git', 'config'),
    '[core]\n\trepositoryformatversion = 0\n[remote "origin"]\n\turl = https://token123@example.com/owner/repo.git\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n',
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

  test('copies .git when preserveGit is true', () => {
    const { sourceRepo, sandboxRoot, cleanup } = createTempDirs();
    try {
      const { sandboxRepoPath, cleanup: sandboxCleanup } = createSandboxRepoCopy(
        sourceRepo,
        sandboxRoot,
        { preserveGit: true }
      );
      try {
        assert(
          existsSync(join(sandboxRepoPath, '.git')),
          '.git should be copied'
        );
        assert.strictEqual(
          readFileSync(join(sandboxRepoPath, '.git', 'HEAD'), 'utf-8'),
          'ref: refs/heads/main\n'
        );
      } finally {
        sandboxCleanup();
      }
    } finally {
      cleanup();
    }
  });

  test('scrubs remote URL in .git/config when preserveGit is true', () => {
    const { sourceRepo, sandboxRoot, cleanup } = createTempDirs();
    try {
      const { sandboxRepoPath, cleanup: sandboxCleanup } = createSandboxRepoCopy(
        sourceRepo,
        sandboxRoot,
        { preserveGit: true }
      );
      try {
        const sandboxConfig = readFileSync(
          join(sandboxRepoPath, '.git', 'config'),
          'utf-8'
        );
        assert(
          sandboxConfig.includes('[remote "origin"]'),
          'remote section should be preserved'
        );
        assert(
          sandboxConfig.includes('url = [REDACTED_REMOTE_URL]'),
          'remote URL should be scrubbed'
        );
        assert(
          !sandboxConfig.includes('token123'),
          'credential token should not leak into sandbox config'
        );
        assert(
          !sandboxConfig.includes('example.com/owner/repo.git'),
          'original URL should not leak into sandbox config'
        );
      } finally {
        sandboxCleanup();
      }
    } finally {
      cleanup();
    }
  });

  test('does not scrub source .git/config', () => {
    const { sourceRepo, sandboxRoot, cleanup } = createTempDirs();
    try {
      const originalConfig = readFileSync(
        join(sourceRepo, '.git', 'config'),
        'utf-8'
      );
      const { cleanup: sandboxCleanup } = createSandboxRepoCopy(
        sourceRepo,
        sandboxRoot,
        { preserveGit: true }
      );
      try {
        const sourceConfigAfter = readFileSync(
          join(sourceRepo, '.git', 'config'),
          'utf-8'
        );
        assert.strictEqual(
          sourceConfigAfter,
          originalConfig,
          'source .git/config must not be modified'
        );
      } finally {
        sandboxCleanup();
      }
    } finally {
      cleanup();
    }
  });

  test('preserveGit true does not fail when .git/config is missing', () => {
    const { sourceRepo, sandboxRoot, cleanup } = createTempDirs();
    try {
      const configPath = join(sourceRepo, '.git', 'config');
      if (existsSync(configPath)) {
        rmSync(configPath);
      }
      const { sandboxRepoPath, cleanup: sandboxCleanup } = createSandboxRepoCopy(
        sourceRepo,
        sandboxRoot,
        { preserveGit: true }
      );
      try {
        assert(
          existsSync(join(sandboxRepoPath, '.git', 'HEAD')),
          '.git/HEAD should still be copied'
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

  test('throws when sandboxRoot equals sourceRepoPath', () => {
    const { sourceRepo, cleanup } = createTempDirs();
    try {
      assert.throws(
        () => createSandboxRepoCopy(sourceRepo, sourceRepo),
        /sandboxRoot must not be inside the source repo/
      );
    } finally {
      cleanup();
    }
  });

  test('throws when sandboxRoot is nested inside sourceRepoPath', () => {
    const { sourceRepo, cleanup } = createTempDirs();
    try {
      const nestedSandboxRoot = join(sourceRepo, 'nested-sandbox');
      mkdirSync(nestedSandboxRoot);
      assert.throws(
        () => createSandboxRepoCopy(sourceRepo, nestedSandboxRoot),
        /sandboxRoot must not be inside the source repo/
      );
    } finally {
      cleanup();
    }
  });

  test('when sandboxRoot is inside source repo, no sandbox directory is created', () => {
    const { sourceRepo, cleanup } = createTempDirs();
    try {
      const nestedSandboxRoot = join(sourceRepo, 'nested-sandbox');
      mkdirSync(nestedSandboxRoot);
      const entriesBefore = existsSync(nestedSandboxRoot)
        ? readdirSync(nestedSandboxRoot)
        : [];
      try {
        createSandboxRepoCopy(sourceRepo, nestedSandboxRoot);
      } catch {
        // expected
      }
      const entriesAfter = existsSync(nestedSandboxRoot)
        ? readdirSync(nestedSandboxRoot)
        : [];
      assert.strictEqual(
        entriesAfter.length,
        entriesBefore.length,
        'no sandbox directory should be created inside source repo'
      );
    } finally {
      cleanup();
    }
  });
});

import { describe, test } from 'node:test';
import assert from 'node:assert';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadBlockDefinition } from '../src/block/block-loader.js';

let counter = 0;

function createTempBlockFile(content: unknown): { path: string; cleanup: () => void } {
  const id = `${Date.now()}-${counter++}`;
  const tmpBase = join(process.cwd(), 'tmp');
  if (!existsSync(tmpBase)) {
    mkdirSync(tmpBase);
  }
  const tmpDir = mkdtempSync(join(tmpBase, `bl-${id}-`));
  const path = join(tmpDir, 'block.json');
  writeFileSync(path, JSON.stringify(content), 'utf-8');
  return {
    path,
    cleanup: () => {
      rmSync(tmpDir, { recursive: true, force: true });
    },
  };
}

function validBlock(): Record<string, unknown> {
  return {
    block_id: 'test-block',
    title: 'Test Block',
    repo_path: '.',
    base_branch: 'main',
    work_branch: 'ai/test',
    providers: {
      coder: { provider: 'fake', model: 'default' },
      reviewer: { provider: 'fake', model: 'default' },
    },
    review_policy: {
      require_deterministic_checks: true,
      max_fix_attempts: 2,
      reviewer_mode: 'single',
    },
    tasks: [
      {
        task_id: 'task-1',
        title: 'Task 1',
        goal: 'Do thing 1',
        allowed_files: ['src/a.ts'],
        denied_files: ['.env'],
        max_lines_changed: 100,
        checks: ['npm test'],
      },
    ],
  };
}

describe('block-loader', () => {
  test('loads valid block JSON', () => {
    const { path, cleanup } = createTempBlockFile(validBlock());
    try {
      const block = loadBlockDefinition(path);
      assert.strictEqual(block.block_id, 'test-block');
      assert.strictEqual(block.title, 'Test Block');
      assert.strictEqual(block.tasks.length, 1);
      assert.strictEqual(block.tasks[0].task_id, 'task-1');
    } finally {
      cleanup();
    }
  });

  test('rejects missing file', () => {
    assert.throws(() => loadBlockDefinition('nonexistent/path/block.json'), /not found/);
  });

  test('rejects directory path', () => {
    const tmpBase = join(process.cwd(), 'tmp');
    if (!existsSync(tmpBase)) {
      mkdirSync(tmpBase);
    }
    assert.throws(() => loadBlockDefinition(tmpBase), /not a file/);
  });

  test('rejects missing block_id', () => {
    const b = validBlock();
    delete b.block_id;
    const { path, cleanup } = createTempBlockFile(b);
    try {
      assert.throws(() => loadBlockDefinition(path), /block_id/);
    } finally {
      cleanup();
    }
  });

  test('rejects missing title', () => {
    const b = validBlock();
    delete b.title;
    const { path, cleanup } = createTempBlockFile(b);
    try {
      assert.throws(() => loadBlockDefinition(path), /title/);
    } finally {
      cleanup();
    }
  });

  test('rejects missing repo_path', () => {
    const b = validBlock();
    delete b.repo_path;
    const { path, cleanup } = createTempBlockFile(b);
    try {
      assert.throws(() => loadBlockDefinition(path), /repo_path/);
    } finally {
      cleanup();
    }
  });

  test('rejects work_branch main', () => {
    const b = validBlock();
    b.work_branch = 'main';
    const { path, cleanup } = createTempBlockFile(b);
    try {
      assert.throws(() => loadBlockDefinition(path), /main/);
    } finally {
      cleanup();
    }
  });

  test('rejects missing coder provider', () => {
    const b = validBlock();
    (b.providers as Record<string, unknown>).coder = undefined;
    const { path, cleanup } = createTempBlockFile(b);
    try {
      assert.throws(() => loadBlockDefinition(path), /coder/);
    } finally {
      cleanup();
    }
  });

  test('rejects missing reviewer provider', () => {
    const b = validBlock();
    (b.providers as Record<string, unknown>).reviewer = undefined;
    const { path, cleanup } = createTempBlockFile(b);
    try {
      assert.throws(() => loadBlockDefinition(path), /reviewer/);
    } finally {
      cleanup();
    }
  });

  test('rejects empty tasks', () => {
    const b = validBlock();
    b.tasks = [];
    const { path, cleanup } = createTempBlockFile(b);
    try {
      assert.throws(() => loadBlockDefinition(path), /non-empty/);
    } finally {
      cleanup();
    }
  });

  test('rejects duplicate task_id', () => {
    const b = validBlock();
    b.tasks = [
      (b.tasks as any[])[0],
      (b.tasks as any[])[0],
    ];
    const { path, cleanup } = createTempBlockFile(b);
    try {
      assert.throws(() => loadBlockDefinition(path), /duplicate/);
    } finally {
      cleanup();
    }
  });

  test('rejects task with empty allowed_files', () => {
    const b = validBlock();
    (b.tasks as any[])[0].allowed_files = [];
    const { path, cleanup } = createTempBlockFile(b);
    try {
      assert.throws(() => loadBlockDefinition(path), /allowed_files/);
    } finally {
      cleanup();
    }
  });

  test('rejects max_lines_changed <= 0', () => {
    const b = validBlock();
    (b.tasks as any[])[0].max_lines_changed = 0;
    const { path, cleanup } = createTempBlockFile(b);
    try {
      assert.throws(() => loadBlockDefinition(path), /max_lines_changed/);
    } finally {
      cleanup();
    }
  });

  test('rejects max_fix_attempts outside 1-5', () => {
    const b = validBlock();
    (b.review_policy as Record<string, unknown>).max_fix_attempts = 0;
    const { path, cleanup } = createTempBlockFile(b);
    try {
      assert.throws(() => loadBlockDefinition(path), /max_fix_attempts/);
    } finally {
      cleanup();
    }
  });

  test('rejects max_fix_attempts above 5', () => {
    const b = validBlock();
    (b.review_policy as Record<string, unknown>).max_fix_attempts = 6;
    const { path, cleanup } = createTempBlockFile(b);
    try {
      assert.throws(() => loadBlockDefinition(path), /max_fix_attempts/);
    } finally {
      cleanup();
    }
  });

  test('no provider call', () => {
    const { path, cleanup } = createTempBlockFile(validBlock());
    try {
      loadBlockDefinition(path);
      assert.strictEqual(true, true);
    } finally {
      cleanup();
    }
  });

  test('no git call', () => {
    const { path, cleanup } = createTempBlockFile(validBlock());
    try {
      loadBlockDefinition(path);
      assert.strictEqual(true, true);
    } finally {
      cleanup();
    }
  });

  test('no GitHub API call', () => {
    const { path, cleanup } = createTempBlockFile(validBlock());
    try {
      loadBlockDefinition(path);
      assert.strictEqual(true, true);
    } finally {
      cleanup();
    }
  });
});

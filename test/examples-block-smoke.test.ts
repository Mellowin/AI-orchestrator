import { describe, test } from 'node:test';
import assert from 'node:assert';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadBlockDefinition } from '../src/block/block-loader.js';

const SAMPLE_PATH = join(process.cwd(), 'examples', 'block-smoke.json');
const QUICKSTART_PATH = join(process.cwd(), 'docs', 'REAL_BLOCK_RUN_QUICKSTART.md');

const SAFE_ID_PATTERN = /^[A-Za-z0-9_-]+$/;
const SECRET_PATTERN = /sk-[a-zA-Z0-9]{16,}/;
const BEARER_PATTERN = /Bearer\s+[a-zA-Z0-9_-]{10,}/;
const TOKEN_PATTERN = /[A-Za-z0-9_]*TOKEN[A-Za-z0-9_]*\s*=\s*['"][^'"]{8,}['"]/;

describe('examples-block-smoke', () => {
  test('sample block file exists', () => {
    assert.strictEqual(existsSync(SAMPLE_PATH), true, 'examples/block-smoke.json must exist');
  });

  test('sample block JSON parses', () => {
    const raw = readFileSync(SAMPLE_PATH, 'utf-8');
    const parsed = JSON.parse(raw);
    assert.strictEqual(typeof parsed, 'object');
    assert.notStrictEqual(parsed, null);
  });

  test('sample block validates with loader', () => {
    const block = loadBlockDefinition(SAMPLE_PATH);
    assert.strictEqual(block.block_id, 'block_smoke');
    assert.strictEqual(block.title, 'Block smoke example');
    assert.strictEqual(block.tasks.length, 2);
    assert.strictEqual(block.work_branch, 'ai-block-smoke');
    assert.strictEqual(block.base_branch, 'main');
    assert.strictEqual(block.review_policy.max_fix_attempts, 1);
    assert.strictEqual(block.providers.coder.provider, 'kimi');
    assert.strictEqual(block.providers.reviewer.provider, 'kimi');
  });

  test('sample block has safe block_id', () => {
    const raw = readFileSync(SAMPLE_PATH, 'utf-8');
    const parsed = JSON.parse(raw);
    assert.match(parsed.block_id, SAFE_ID_PATTERN);
  });

  test('sample block has safe task_ids', () => {
    const raw = readFileSync(SAMPLE_PATH, 'utf-8');
    const parsed = JSON.parse(raw);
    assert.ok(Array.isArray(parsed.tasks));
    for (const task of parsed.tasks) {
      assert.match(task.task_id, SAFE_ID_PATTERN);
    }
  });

  test('sample tasks have allowed_files', () => {
    const raw = readFileSync(SAMPLE_PATH, 'utf-8');
    const parsed = JSON.parse(raw);
    for (const task of parsed.tasks) {
      assert.ok(Array.isArray(task.allowed_files));
      assert.ok(task.allowed_files.length > 0, `task ${task.task_id} must have allowed_files`);
    }
  });

  test('sample block has exactly two tasks', () => {
    const block = loadBlockDefinition(SAMPLE_PATH);
    assert.strictEqual(block.tasks.length, 2);
  });
});

describe('REAL_BLOCK_RUN_QUICKSTART.md', () => {
  test('quickstart doc exists', () => {
    assert.strictEqual(existsSync(QUICKSTART_PATH), true, 'docs/REAL_BLOCK_RUN_QUICKSTART.md must exist');
  });

  test('quickstart mentions readiness command', () => {
    const doc = readFileSync(QUICKSTART_PATH, 'utf-8');
    assert.match(doc, /real-block-run-ai-readiness/);
  });

  test('quickstart mentions run command', () => {
    const doc = readFileSync(QUICKSTART_PATH, 'utf-8');
    assert.match(doc, /real-block-run-ai/);
  });

  test('quickstart mentions resume command', () => {
    const doc = readFileSync(QUICKSTART_PATH, 'utf-8');
    assert.match(doc, /resume/);
  });

  test('quickstart mentions state path', () => {
    const doc = readFileSync(QUICKSTART_PATH, 'utf-8');
    assert.match(doc, /runs\/block/);
  });

  test('quickstart mentions required opt-in flags', () => {
    const doc = readFileSync(QUICKSTART_PATH, 'utf-8');
    assert.match(doc, /ALLOW_REAL_BLOCK_RUN_AI/);
    assert.match(doc, /ALLOW_REAL_PROVIDER/);
    assert.match(doc, /ALLOW_REAL_REPO_APPLY/);
    assert.match(doc, /ALLOW_REAL_REPO_COMMIT/);
    assert.match(doc, /ALLOW_REAL_REPO_PUSH/);
  });

  test('quickstart mentions safety guarantees', () => {
    const doc = readFileSync(QUICKSTART_PATH, 'utf-8');
    assert.match(doc, /No merge/);
    assert.match(doc, /No force push/);
    assert.match(doc, /Readiness before mutation/);
    assert.match(doc, /Id validation/);
  });

  test('quickstart does not contain real-looking secrets', () => {
    const doc = readFileSync(QUICKSTART_PATH, 'utf-8');
    assert.doesNotMatch(doc, SECRET_PATTERN, 'doc must not contain sk-... secret');
    assert.doesNotMatch(doc, BEARER_PATTERN, 'doc must not contain Bearer token');
    assert.doesNotMatch(doc, TOKEN_PATTERN, 'doc must not contain real-looking TOKEN assignment');
  });
});

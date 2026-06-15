import { describe, test } from 'node:test';
import assert from 'node:assert';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const RELEASE_DOC_PATH = join(process.cwd(), 'docs', 'STAGE_10_V0_RELEASE.md');
const README_PATH = join(process.cwd(), 'README.md');
const QUICKSTART_PATH = join(process.cwd(), 'docs', 'REAL_BLOCK_RUN_QUICKSTART.md');

const SECRET_PATTERN = /sk-[a-zA-Z0-9]{16,}/;
const BEARER_PATTERN = /Bearer\s+[a-zA-Z0-9_-]{10,}/;
const TOKEN_ASSIGN_PATTERN = /[A-Za-z0-9_]*TOKEN[A-Za-z0-9_]*\s*=\s*['"][^'"]{8,}['"]/;

function readReleaseDoc(): string {
  if (!existsSync(RELEASE_DOC_PATH)) {
    throw new Error(`Release snapshot doc not found: ${RELEASE_DOC_PATH}`);
  }
  return readFileSync(RELEASE_DOC_PATH, 'utf-8');
}

describe('stage 10 v0 release snapshot doc', () => {
  test('release snapshot doc exists', () => {
    assert.ok(existsSync(RELEASE_DOC_PATH), 'STAGE_10_V0_RELEASE.md must exist');
  });

  test('release snapshot doc contains title', () => {
    const doc = readReleaseDoc();
    assert.match(doc, /Stage 10 v0 Release Snapshot/);
  });

  test('release snapshot doc mentions demo command', () => {
    const doc = readReleaseDoc();
    assert.match(doc, /npm run demo:block:fake/);
  });

  test('release snapshot doc mentions verify command', () => {
    const doc = readReleaseDoc();
    assert.match(doc, /npm run verify:product/);
  });

  test('release snapshot doc mentions readiness command', () => {
    const doc = readReleaseDoc();
    assert.match(doc, /real-block-run-ai-readiness/);
  });

  test('release snapshot doc mentions run command', () => {
    const doc = readReleaseDoc();
    assert.match(doc, /real-block-run-ai/);
  });

  test('release snapshot doc mentions report command', () => {
    const doc = readReleaseDoc();
    assert.match(doc, /real-block-run-ai-report/);
  });

  test('release snapshot doc mentions resume', () => {
    const doc = readReleaseDoc();
    assert.match(doc, /--resume/);
  });

  test('release snapshot doc mentions end-to-end flow', () => {
    const doc = readReleaseDoc();
    assert.match(doc, /readiness\s*→\s*run\s*→\s*report|readiness → run → reviewer gate → optional fix → second review → persisted state → report/);
  });

  test('release snapshot doc mentions state path', () => {
    const doc = readReleaseDoc();
    assert.match(doc, /runs\/block\/<block_id>\/state\.json/);
  });

  test('release snapshot doc mentions readiness before mutation', () => {
    const doc = readReleaseDoc();
    assert.match(doc, /Readiness before mutation/i);
  });

  test('release snapshot doc mentions safe block/task ids', () => {
    const doc = readReleaseDoc();
    assert.match(doc, /Safe block\/task ids/i);
  });

  test('release snapshot doc mentions no shell interpolation', () => {
    const doc = readReleaseDoc();
    assert.match(doc, /No shell interpolation/i);
  });

  test('release snapshot doc mentions redaction', () => {
    const doc = readReleaseDoc();
    assert.match(doc, /Redaction/i);
  });

  test('release snapshot doc mentions no merge', () => {
    const doc = readReleaseDoc();
    assert.match(doc, /No merge/i);
  });

  test('release snapshot doc mentions no force push', () => {
    const doc = readReleaseDoc();
    assert.match(doc, /No force push/i);
  });

  test('release snapshot doc mentions known limitations', () => {
    const doc = readReleaseDoc();
    assert.match(doc, /Known limitations/i);
  });

  test('release snapshot doc mentions one fix attempt limitation', () => {
    const doc = readReleaseDoc();
    assert.match(doc, /One fix attempt/i);
  });

  test('release snapshot doc mentions no UI yet', () => {
    const doc = readReleaseDoc();
    assert.match(doc, /No UI yet/i);
  });

  test('release snapshot doc mentions GitHub Actions product verification', () => {
    const doc = readReleaseDoc();
    assert.match(doc, /GitHub Actions.*product verification|product verification.*GitHub Actions/i);
  });

  test('README links to release snapshot', () => {
    assert.ok(existsSync(README_PATH), 'README.md must exist');
    const readme = readFileSync(README_PATH, 'utf-8');
    assert.match(readme, /STAGE_10_V0_RELEASE\.md/);
  });

  test('quickstart links to release snapshot', () => {
    assert.ok(existsSync(QUICKSTART_PATH), 'REAL_BLOCK_RUN_QUICKSTART.md must exist');
    const doc = readFileSync(QUICKSTART_PATH, 'utf-8');
    assert.match(doc, /STAGE_10_V0_RELEASE\.md/);
  });

  test('release snapshot doc does not contain real-looking secrets', () => {
    const doc = readReleaseDoc();
    assert.doesNotMatch(doc, SECRET_PATTERN, 'must not contain sk- secret');
    assert.doesNotMatch(doc, BEARER_PATTERN, 'must not contain Bearer token');
    assert.doesNotMatch(doc, TOKEN_ASSIGN_PATTERN, 'must not contain real-looking TOKEN assignment');
  });
});

import { describe, test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  collectUnauthorizedFiles,
  collectDiff,
  runMissionFinalReview,
  resolveAuthorizedMaintenanceFiles,
} from '../src/autopilot-one-click/multitask/final-review.js';
import type { FinalReviewInput, AuthorizedMaintenanceEvidence } from '../src/autopilot-one-click/multitask/types.js';

describe('collectUnauthorizedFiles validates both sides of renames', () => {
  test('create outside allowlist is unauthorized', () => {
    const diff = [
      'diff --git a/new-file.ts b/new-file.ts',
      'new file mode 100644',
      'index 0000000..e69de29',
      '--- /dev/null',
      '+++ b/new-file.ts',
    ].join('\n');
    const files = collectUnauthorizedFiles(diff, ['src/**']);
    assert.deepStrictEqual(files, ['new-file.ts']);
  });

  test('delete outside allowlist is unauthorized', () => {
    const diff = [
      'diff --git a/old-file.ts b/old-file.ts',
      'deleted file mode 100644',
      'index e69de29..0000000',
      '--- a/old-file.ts',
      '+++ /dev/null',
    ].join('\n');
    const files = collectUnauthorizedFiles(diff, ['src/**']);
    assert.deepStrictEqual(files, ['old-file.ts']);
  });

  test('rename from allowed to out-of-scope fails on destination', () => {
    const diff = [
      'diff --git a/src/old.ts b/out/new.ts',
      'similarity index 100%',
      'rename from src/old.ts',
      'rename to out/new.ts',
    ].join('\n');
    const files = collectUnauthorizedFiles(diff, ['src/**']);
    assert.ok(files.includes('out/new.ts'), `expected out/new.ts in ${files.join(', ')}`);
  });

  test('rename from out-of-scope to allowed fails on source', () => {
    const diff = [
      'diff --git a/out/old.ts b/src/new.ts',
      'similarity index 100%',
      'rename from out/old.ts',
      'rename to src/new.ts',
    ].join('\n');
    const files = collectUnauthorizedFiles(diff, ['src/**']);
    assert.ok(files.includes('out/old.ts'), `expected out/old.ts in ${files.join(', ')}`);
  });

  test('rename within allowlist is authorized', () => {
    const diff = [
      'diff --git a/src/old.ts b/src/new.ts',
      'similarity index 100%',
      'rename from src/old.ts',
      'rename to src/new.ts',
    ].join('\n');
    const files = collectUnauthorizedFiles(diff, ['src/**']);
    assert.deepStrictEqual(files, []);
  });

  test('normal modification within allowlist stays authorized', () => {
    const diff = [
      'diff --git a/src/foo.ts b/src/foo.ts',
      'index e69de29..d8649da 100644',
      '--- a/src/foo.ts',
      '+++ b/src/foo.ts',
      '@@ -1 +1 @@',
      '-old',
      '+new',
    ].join('\n');
    const files = collectUnauthorizedFiles(diff, ['src/**']);
    assert.deepStrictEqual(files, []);
  });
});


describe('collectDiff fails closed', () => {
  test('throws when both git diff attempts fail in a non-git directory', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'no-git-'));
    assert.throws(
      () => collectDiff(tmpDir, 'main', 'work'),
      /Could not collect diff/
    );
    rmSync(tmpDir, { recursive: true, force: true });
  });
});

const SHA = 'a'.repeat(40);

function diffFor(paths: string[]): string {
  return paths
    .map((p) =>
      [
        `diff --git a/${p} b/${p}`,
        'index e69de29..d8649da 100644',
        `--- a/${p}`,
        `+++ b/${p}`,
        '@@ -1 +1 @@',
        '-old',
        '+new',
      ].join('\n')
    )
    .join('\n');
}

function makeReviewInput(
  diff: string,
  authorized_maintenance?: AuthorizedMaintenanceEvidence
): FinalReviewInput {
  return {
    mission: { goal: 'g', constraints: [] } as unknown as FinalReviewInput['mission'],
    plan: {
      tasks: [{ id: 'task-1', title: 't', goal: 'g', allowed_files: ['docs/autonomous-workflow/*.md'] }],
    } as unknown as FinalReviewInput['plan'],
    autopilotResult: {
      verdict: 'AUTOPILOT_GREEN',
      reason: 'ok',
      repair_attempts: 0,
    } as unknown as FinalReviewInput['autopilotResult'],
    integratedDiff: diff,
    taskStates: [{ task_id: 'task-1', status: 'accepted' }],
    authorized_maintenance,
  };
}

function makeEvidence(overrides: Partial<AuthorizedMaintenanceEvidence> = {}): AuthorizedMaintenanceEvidence {
  return {
    classification: 'REPAIRABLE_REPOSITORY_FAILURE',
    maintenance_files: ['TESTING_SUMMARY.md'],
    repair_files: ['TESTING_SUMMARY.md'],
    repair_commit_sha: SHA,
    revalidation_ok: true,
    ...overrides,
  };
}

describe('final review authorized maintenance scope', () => {
  test('authorized maintenance file is not unauthorized when repair evidence is valid', async () => {
    const input = makeReviewInput(
      diffFor(['docs/autonomous-workflow/01-one-click.md', 'TESTING_SUMMARY.md']),
      makeEvidence()
    );
    const review = await runMissionFinalReview(input);
    assert.deepStrictEqual(review.unauthorized_files ?? [], []);
    assert.strictEqual(review.verdict, 'approved');
  });

  test('unrelated extra file outside both scopes is still rejected', async () => {
    const input = makeReviewInput(
      diffFor(['docs/autonomous-workflow/01-one-click.md', 'TESTING_SUMMARY.md', 'package.json']),
      makeEvidence()
    );
    const review = await runMissionFinalReview(input);
    assert.deepStrictEqual(review.unauthorized_files, ['package.json']);
    assert.strictEqual(review.verdict, 'rejected');
  });

  test('maintenance file without any authorization evidence is unauthorized', async () => {
    const input = makeReviewInput(
      diffFor(['docs/autonomous-workflow/01-one-click.md', 'TESTING_SUMMARY.md'])
    );
    const review = await runMissionFinalReview(input);
    assert.deepStrictEqual(review.unauthorized_files, ['TESTING_SUMMARY.md']);
    assert.strictEqual(review.verdict, 'rejected');
  });

  test('maintenance authorization with failed revalidation grants no allowance', async () => {
    const input = makeReviewInput(
      diffFor(['docs/autonomous-workflow/01-one-click.md', 'TESTING_SUMMARY.md']),
      makeEvidence({ revalidation_ok: false as unknown as true })
    );
    const review = await runMissionFinalReview(input);
    assert.deepStrictEqual(review.unauthorized_files, ['TESTING_SUMMARY.md']);
  });

  test('repair files outside validator maintenanceFiles invalidate the evidence', async () => {
    const evidence = makeEvidence({ repair_files: ['TESTING_SUMMARY.md', 'package.json'] });
    assert.deepStrictEqual(resolveAuthorizedMaintenanceFiles(evidence), []);
    const input = makeReviewInput(
      diffFor(['docs/autonomous-workflow/01-one-click.md', 'TESTING_SUMMARY.md']),
      evidence
    );
    const review = await runMissionFinalReview(input);
    assert.deepStrictEqual(review.unauthorized_files, ['TESTING_SUMMARY.md']);
  });

  test('missing or malformed repair commit SHA fails closed', () => {
    assert.deepStrictEqual(resolveAuthorizedMaintenanceFiles(makeEvidence({ repair_commit_sha: '' })), []);
    assert.deepStrictEqual(resolveAuthorizedMaintenanceFiles(makeEvidence({ repair_commit_sha: 'not-a-sha' })), []);
    assert.deepStrictEqual(
      resolveAuthorizedMaintenanceFiles(
        makeEvidence({ classification: 'EXTERNAL_BLOCKER' as unknown as 'REPAIRABLE_REPOSITORY_FAILURE' })
      ),
      []
    );
    assert.deepStrictEqual(resolveAuthorizedMaintenanceFiles(makeEvidence({ maintenance_files: [] })), []);
    assert.deepStrictEqual(resolveAuthorizedMaintenanceFiles(undefined), []);
  });

  test('reviewer prompt names task scope and authorized maintenance separately', async () => {
    let prompt = '';
    const input = makeReviewInput(
      diffFor(['docs/autonomous-workflow/01-one-click.md', 'TESTING_SUMMARY.md']),
      makeEvidence()
    );
    await runMissionFinalReview(input, async (p) => {
      prompt = p;
      return JSON.stringify({ verdict: 'approved', summary: 'ok', caveats: [], unauthorized_files: [], acceptance_gaps: [] });
    });
    assert.ok(prompt.includes('Task writable scope'), prompt);
    assert.ok(prompt.includes('System-authorized finalization maintenance'), prompt);
    assert.ok(prompt.includes('TESTING_SUMMARY.md'), prompt);
    assert.ok(prompt.includes(SHA), prompt);
  });
});

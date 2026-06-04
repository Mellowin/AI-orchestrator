import { describe, it } from 'node:test';
import assert from 'node:assert';
import { validateRealOneTaskModeSafety } from '../src/block/block-real-mode-safety.js';

describe('block-real-mode-safety', () => {
  const baseInput = {
    mode: 'real_kimi_coder_fake_reviewer' as const,
    allowBlockRunOne: true,
    allowRealProvider: true,
    allowRealRepoApply: true,
    allowRealRepoCommit: true,
    allowRealRepoPush: false,
    allowKimiReviewer: false,
    coderProvider: 'kimi',
    reviewerProvider: 'fake',
    repoPath: '/tmp/repo',
    workBranch: 'feature/test',
    currentBranch: 'feature/test',
    gitStatus: '',
  };

  it('fake mode ok', () => {
    const result = validateRealOneTaskModeSafety({ ...baseInput, mode: 'fake' });
    assert.strictEqual(result.ok, true);
    assert.deepStrictEqual(result.blockingIssues, []);
  });

  it('real mode requires ALLOW_BLOCK_RUN_ONE', () => {
    const result = validateRealOneTaskModeSafety({ ...baseInput, allowBlockRunOne: false });
    assert.strictEqual(result.ok, false);
    assert.ok(result.blockingIssues.some((i) => i.includes('ALLOW_BLOCK_RUN_ONE')));
  });

  it('real mode requires ALLOW_REAL_PROVIDER', () => {
    const result = validateRealOneTaskModeSafety({ ...baseInput, allowRealProvider: false });
    assert.strictEqual(result.ok, false);
    assert.ok(result.blockingIssues.some((i) => i.includes('ALLOW_REAL_PROVIDER')));
  });

  it('real mode requires ALLOW_REAL_REPO_APPLY', () => {
    const result = validateRealOneTaskModeSafety({ ...baseInput, allowRealRepoApply: false });
    assert.strictEqual(result.ok, false);
    assert.ok(result.blockingIssues.some((i) => i.includes('ALLOW_REAL_REPO_APPLY')));
  });

  it('real mode requires ALLOW_REAL_REPO_COMMIT', () => {
    const result = validateRealOneTaskModeSafety({ ...baseInput, allowRealRepoCommit: false });
    assert.strictEqual(result.ok, false);
    assert.ok(result.blockingIssues.some((i) => i.includes('ALLOW_REAL_REPO_COMMIT')));
  });

  it('real mode requires coderProvider kimi', () => {
    const result = validateRealOneTaskModeSafety({ ...baseInput, coderProvider: 'fake' });
    assert.strictEqual(result.ok, false);
    assert.ok(result.blockingIssues.some((i) => i.includes('coderProvider=kimi')));
  });

  it('real mode requires reviewerProvider fake', () => {
    const result = validateRealOneTaskModeSafety({ ...baseInput, reviewerProvider: 'kimi' });
    assert.strictEqual(result.ok, false);
    assert.ok(result.blockingIssues.some((i) => i.includes('reviewerProvider=fake')));
  });

  it('real_kimi_coder_kimi_reviewer rejected in Stage 6.5', () => {
    const result = validateRealOneTaskModeSafety({
      ...baseInput,
      mode: 'real_kimi_coder_kimi_reviewer' as const,
    });
    assert.strictEqual(result.ok, false);
    assert.ok(result.blockingIssues.some((i) => i.includes('not enabled in Stage 6.5')));
  });

  it('rejects currentBranch main', () => {
    const result = validateRealOneTaskModeSafety({ ...baseInput, currentBranch: 'main' });
    assert.strictEqual(result.ok, false);
    assert.ok(result.blockingIssues.some((i) => i.includes('main')));
  });

  it('rejects currentBranch HEAD', () => {
    const result = validateRealOneTaskModeSafety({ ...baseInput, currentBranch: 'HEAD' });
    assert.strictEqual(result.ok, false);
    assert.ok(result.blockingIssues.some((i) => i.includes('HEAD')));
  });

  it('rejects branch mismatch', () => {
    const result = validateRealOneTaskModeSafety({ ...baseInput, currentBranch: 'feature/other' });
    assert.strictEqual(result.ok, false);
    assert.ok(result.blockingIssues.some((i) => i.includes('does not match work branch')));
  });

  it('rejects workBranch main', () => {
    const result = validateRealOneTaskModeSafety({ ...baseInput, workBranch: 'main', currentBranch: 'main' });
    assert.strictEqual(result.ok, false);
    assert.ok(result.blockingIssues.some((i) => i.includes('Work branch must not be main')));
  });

  it('rejects dirty git status', () => {
    const result = validateRealOneTaskModeSafety({ ...baseInput, gitStatus: 'M file.txt' });
    assert.strictEqual(result.ok, false);
    assert.ok(result.blockingIssues.some((i) => i.includes('not clean')));
  });

  it('safe errors do not leak env values', () => {
    const result = validateRealOneTaskModeSafety({
      ...baseInput,
      allowRealProvider: false,
      repoPath: '/secret/path',
    });
    assert.strictEqual(result.ok, false);
    const text = result.blockingIssues.join(' ');
    assert.ok(!text.includes('/secret/path'), 'repoPath leaked in error');
  });
});

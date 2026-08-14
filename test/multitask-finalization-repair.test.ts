import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runIntegratedValidation } from '../src/autopilot-one-click/multitask/integrated-validator.js';
import { runFinalizationRepair } from '../src/autopilot-one-click/multitask/finalization-repair.js';

let counter = 0;

function createTempRepo(): { repoPath: string; initialSha: string } {
  const tmpBase = join(process.cwd(), 'tmp');
  if (!existsSync(tmpBase)) {
    mkdirSync(tmpBase);
  }
  const tmpDir = mkdtempSync(join(tmpBase, `finalization-repair-${Date.now()}-${counter++}-`));
  const repoPath = join(tmpDir, 'repo');
  mkdirSync(repoPath);

  spawnSync('git', ['init'], { cwd: repoPath, encoding: 'utf-8', shell: false });
  spawnSync('git', ['config', 'user.email', 'ci@example.com'], { cwd: repoPath, encoding: 'utf-8', shell: false });
  spawnSync('git', ['config', 'user.name', 'CI User'], { cwd: repoPath, encoding: 'utf-8', shell: false });

  writeFileSync(
    join(repoPath, 'package.json'),
    JSON.stringify({
      name: 'temp-repo',
      version: '0.0.1',
      scripts: {
        'verify:summary': 'node scripts/verify-testing-summary.mjs',
        'verify:product': 'echo ok',
        'verify:product:ci': 'echo ok',
        'test:chunks:product': 'echo ok',
        'test:chunks:product:ci': 'echo ok',
      },
    }),
    'utf-8'
  );

  const realVerifier = readFileSync(join(process.cwd(), 'scripts', 'verify-testing-summary.mjs'), 'utf-8');
  mkdirSync(join(repoPath, 'scripts'));
  writeFileSync(join(repoPath, 'scripts', 'verify-testing-summary.mjs'), realVerifier, 'utf-8');

  mkdirSync(join(repoPath, '.github', 'workflows'), { recursive: true });
  writeFileSync(
    join(repoPath, '.github', 'workflows', 'product-verify.yml'),
    'on:\n  workflow_dispatch:\n',
    'utf-8'
  );

  writeFileSync(
    join(repoPath, 'TESTING_SUMMARY.md'),
    '# Summary\n\n**Last verified:** `INITIAL_SHA_PLACEHOLDER`\n\n## Test metrics\n\n- **Last verified commit:** `INITIAL_SHA_PLACEHOLDER`\n',
    'utf-8'
  );

  spawnSync('git', ['add', '.'], { cwd: repoPath, encoding: 'utf-8', shell: false });
  spawnSync('git', ['commit', '-m', 'init', '--no-gpg-sign'], { cwd: repoPath, encoding: 'utf-8', shell: false });

  const headResult = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repoPath, encoding: 'utf-8', shell: false });
  const initialSha = headResult.stdout.trim();
  const summary = readFileSync(join(repoPath, 'TESTING_SUMMARY.md'), 'utf-8')
    .replace(/INITIAL_SHA_PLACEHOLDER/g, initialSha);
  writeFileSync(join(repoPath, 'TESTING_SUMMARY.md'), summary, 'utf-8');
  spawnSync('git', ['add', 'TESTING_SUMMARY.md'], { cwd: repoPath, encoding: 'utf-8', shell: false });
  spawnSync('git', ['commit', '-m', 'lock summary', '--no-gpg-sign'], { cwd: repoPath, encoding: 'utf-8', shell: false });

  return { repoPath, initialSha };
}

function makeFakeSpawn(repoPath: string) {
  const calls: Array<{ command: string; args: string[] }> = [];
  const fakeSpawn = (command: string, args: string[], options?: { cwd?: string; encoding?: string; shell?: boolean }) => {
    calls.push({ command, args });

    if (command === 'git' && args[0] === 'rev-parse' && args[1] === 'HEAD') {
      const result = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repoPath, encoding: 'utf-8', shell: false });
      return { status: result.status, stdout: result.stdout, stderr: result.stderr };
    }

    if (command === 'git') {
      return { status: 0, stdout: '', stderr: '' };
    }

    if (command === 'node') {
      return spawnSync(command, args, { cwd: options?.cwd ?? repoPath, encoding: 'utf-8', shell: false });
    }

    return { status: 1, stdout: '', stderr: `unexpected command: ${command} ${args.join(' ')}` };
  };
  return { fakeSpawn, calls };
}

describe('finalization-repair', () => {
  test('deterministic TESTING_SUMMARY fallback repairs a REPAIRABLE_REPOSITORY_FAILURE', async () => {
    const { repoPath, initialSha } = createTempRepo();

    // Add a non-summary file after the lock.
    mkdirSync(join(repoPath, 'docs'), { recursive: true });
    writeFileSync(join(repoPath, 'docs', 'new.md'), '# new doc\n', 'utf-8');
    spawnSync('git', ['add', 'docs/new.md'], { cwd: repoPath, encoding: 'utf-8', shell: false });
    spawnSync('git', ['commit', '-m', 'add doc', '--no-gpg-sign'], { cwd: repoPath, encoding: 'utf-8', shell: false });

    const validationResult = runIntegratedValidation(repoPath);
    assert.strictEqual(validationResult.classification, 'REPAIRABLE_REPOSITORY_FAILURE');

    const { fakeSpawn } = makeFakeSpawn(repoPath);

    const repairResult = await runFinalizationRepair(
      {
        repoPath,
        workBranch: 'main',
        missionGoal: 'Create docs',
        missionAllowedFiles: ['docs/new.md'],
        missionDeniedFiles: [],
        validationResult,
        reportDir: join(repoPath, '..', 'report'),
        attempt: 1,
        maxAttempts: 2,
      },
      {
        spawnFn: fakeSpawn as typeof spawnSync,
        aiGenerateFn: async () => 'invalid json',
        validateFn: (repoPath: string) => runIntegratedValidation(repoPath),
      }
    );

    assert.strictEqual(repairResult.ok, true, repairResult.reason);
    assert.deepStrictEqual(repairResult.files, ['TESTING_SUMMARY.md']);
    assert.strictEqual(repairResult.aiGenerated, false);

    const summaryContent = readFileSync(join(repoPath, 'TESTING_SUMMARY.md'), 'utf-8');
    assert(!summaryContent.includes(initialSha), 'TESTING_SUMMARY.md should no longer contain the stale SHA');

    const finalValidation = runIntegratedValidation(repoPath);
    assert.strictEqual(finalValidation.ok, true, `Expected post-repair validation to pass: ${finalValidation.output}`);

    rmSync(join(repoPath, '..'), { recursive: true, force: true });
  });

  test('AI-generated repair candidate is used when valid', async () => {
    const { repoPath, initialSha } = createTempRepo();

    mkdirSync(join(repoPath, 'docs'), { recursive: true });
    writeFileSync(join(repoPath, 'docs', 'new.md'), '# new doc\n', 'utf-8');
    spawnSync('git', ['add', 'docs/new.md'], { cwd: repoPath, encoding: 'utf-8', shell: false });
    spawnSync('git', ['commit', '-m', 'add doc', '--no-gpg-sign'], { cwd: repoPath, encoding: 'utf-8', shell: false });

    const validationResult = runIntegratedValidation(repoPath);
    assert.strictEqual(validationResult.classification, 'REPAIRABLE_REPOSITORY_FAILURE');

    const { fakeSpawn } = makeFakeSpawn(repoPath);

    const currentSha = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repoPath, encoding: 'utf-8', shell: false }).stdout.trim();
    const updatedSummary = readFileSync(join(repoPath, 'TESTING_SUMMARY.md'), 'utf-8')
      .replaceAll(initialSha, currentSha);

    const repairResult = await runFinalizationRepair(
      {
        repoPath,
        workBranch: 'main',
        missionGoal: 'Create docs',
        missionAllowedFiles: ['docs/new.md'],
        missionDeniedFiles: [],
        validationResult,
        reportDir: join(repoPath, '..', 'report'),
        attempt: 1,
        maxAttempts: 2,
      },
      {
        spawnFn: fakeSpawn as typeof spawnSync,
        aiGenerateFn: async () =>
          JSON.stringify({
            mode: 'file_update',
            files: [{ path: 'TESTING_SUMMARY.md', content: updatedSummary }],
            notes: 'Update TESTING_SUMMARY lock to current HEAD',
          }),
        validateFn: (repoPath: string) => runIntegratedValidation(repoPath),
      }
    );

    assert.strictEqual(repairResult.ok, true, repairResult.reason);
    assert.deepStrictEqual(repairResult.files, ['TESTING_SUMMARY.md']);
    assert.strictEqual(repairResult.aiGenerated, true);

    const finalValidation = runIntegratedValidation(repoPath);
    assert.strictEqual(finalValidation.ok, true, `Expected post-repair validation to pass: ${finalValidation.output}`);

    rmSync(join(repoPath, '..'), { recursive: true, force: true });
  });
});

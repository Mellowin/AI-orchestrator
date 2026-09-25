import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  extractScriptTargetFiles,
  extractWorkflowCommands,
  validateRepoCiContract,
} from '../src/ci-contract.js';

let counter = 0;

function tmpRepo(): string {
  counter += 1;
  const base = join(process.cwd(), 'tmp');
  if (!existsSync(base)) {
    mkdirSync(base);
  }
  return mkdtempSync(join(base, `ci-contract-${Date.now()}-${counter++}-`));
}

function writeMinimalRepo(repoPath: string, packageScripts: Record<string, string>, workflowYaml: string): void {
  mkdirSync(join(repoPath, '.github', 'workflows'), { recursive: true });
  writeFileSync(join(repoPath, 'package.json'), JSON.stringify({ name: 'x', version: '0.0.1', scripts: packageScripts }), 'utf-8');
  writeFileSync(join(repoPath, '.github', 'workflows', 'ci.yml'), workflowYaml, 'utf-8');
}

const BROKEN_BASELINE_CI_YML = `
name: Mini-MVP CI
on:
  pull_request:
jobs:
  checks:
    runs-on: ubuntu-latest
    steps:
      - name: Type check
        run: npm run typecheck
  rollback-drill-smoke:
    runs-on: ubuntu-latest
    needs: checks
    steps:
      - name: Rollback policy drill smoke
        run: npm run demo:rollback-policy-drill
  post-push-follow-up-drill-smoke:
    runs-on: ubuntu-latest
    needs: checks
    steps:
      - name: Post-push follow-up drill smoke
        run: |
          npm run demo:post-push-follow-up-drill
  block-follow-up-drill-smoke:
    runs-on: ubuntu-latest
    needs: checks
    steps:
      - name: Block follow-up drill smoke
        run: npm run demo:block-follow-up-drill
`;

describe('ci-contract validator (stage 18.26h)', () => {
  test('broken baseline: detects exactly the three missing drill scripts', () => {
    const repoPath = tmpRepo();
    try {
      writeMinimalRepo(
        repoPath,
        { typecheck: 'tsc --noEmit', build: 'tsc', test: 'node scripts/run-test-chunks.mjs' },
        BROKEN_BASELINE_CI_YML
      );

      const report = validateRepoCiContract(repoPath);

      assert.strictEqual(report.ok, false);
      const missing = report.violations.filter((v) => v.kind === 'missing_npm_script');
      assert.strictEqual(missing.length, 3);
      assert.deepStrictEqual(
        missing.map((v) => v.npm_script).sort(),
        [
          'demo:block-follow-up-drill',
          'demo:post-push-follow-up-drill',
          'demo:rollback-policy-drill',
        ].sort()
      );
      // Job/step attribution is preserved for actionable evidence.
      const rollback = missing.find((v) => v.npm_script === 'demo:rollback-policy-drill');
      assert.strictEqual(rollback?.job, 'rollback-drill-smoke');
      assert.strictEqual(rollback?.step, 'Rollback policy drill smoke');
      // Block scalar commands are parsed too.
      const postPush = missing.find((v) => v.npm_script === 'demo:post-push-follow-up-drill');
      assert.strictEqual(postPush?.job, 'post-push-follow-up-drill-smoke');
    } finally {
      rmSync(repoPath, { recursive: true, force: true });
    }
  });

  test('restored contract: all scripts exist and target files exist', () => {
    const repoPath = tmpRepo();
    try {
      writeMinimalRepo(
        repoPath,
        {
          typecheck: 'tsc --noEmit',
          'demo:rollback-policy-drill': 'node scripts/run-rollback-policy-drill.mjs',
        },
        BROKEN_BASELINE_CI_YML.replace('npm run demo:post-push-follow-up-drill', 'npm run typecheck')
          .replace('npm run demo:block-follow-up-drill', 'npm run typecheck')
      );
      mkdirSync(join(repoPath, 'scripts'));
      writeFileSync(join(repoPath, 'scripts', 'run-rollback-policy-drill.mjs'), '// drill\n', 'utf-8');

      const report = validateRepoCiContract(repoPath);
      assert.strictEqual(report.ok, true, report.violations.map((v) => v.message).join('\n'));
    } finally {
      rmSync(repoPath, { recursive: true, force: true });
    }
  });

  test('missing script target file is reported', () => {
    const repoPath = tmpRepo();
    try {
      writeMinimalRepo(repoPath, { drill: 'node scripts/missing.mjs' }, 'on: push\n');
      const report = validateRepoCiContract(repoPath);
      assert.strictEqual(report.ok, false);
      assert.strictEqual(report.violations[0].kind, 'missing_script_target_file');
      assert.strictEqual(report.violations[0].target_file, 'scripts/missing.mjs');
    } finally {
      rmSync(repoPath, { recursive: true, force: true });
    }
  });

  test('extractWorkflowCommands handles inline and block run scalars', () => {
    const commands = extractWorkflowCommands(
      'jobs:\n  a:\n    steps:\n      - name: S1\n        run: npm run one\n      - name: S2\n        run: |\n          npm run two\n          npm run three\n'
    );
    assert.deepStrictEqual(commands.map((c) => [c.job, c.step, c.run]), [
      ['a', 'S1', 'npm run one'],
      ['a', 'S2', 'npm run two\nnpm run three'],
    ]);
  });

  test('extractScriptTargetFiles only matches node/tsx file invocations', () => {
    const targets = extractScriptTargetFiles({
      a: 'node scripts/a.mjs',
      b: 'tsx scripts/b.ts',
      c: 'node --watch scripts/c.mjs',
      d: 'npm run typecheck',
      e: 'echo hello',
    });
    assert.deepStrictEqual(targets, [
      { script: 'a', target_file: 'scripts/a.mjs' },
      { script: 'b', target_file: 'scripts/b.ts' },
    ]);
  });
});

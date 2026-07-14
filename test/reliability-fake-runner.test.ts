import { describe, test } from 'node:test';
import assert from 'node:assert';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import type { ReliabilityConfig, ReliabilityScenarioConfig } from '../src/reliability/types.js';
import { runReliabilityCampaign } from '../src/reliability/runner.js';

function makeTempDir(prefix: string): string {
  return mkdtempSync(join(mkdtempSync(prefix), 'inner'));
}

describe('reliability fake runner', () => {
  function buildSourceRepo(): string {
    const dir = makeTempDir('rel-fake-src-');
    spawnSync('git', ['init'], { cwd: dir, encoding: 'utf-8', shell: false });
    spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir, encoding: 'utf-8', shell: false });
    spawnSync('git', ['config', 'user.name', 'Test'], { cwd: dir, encoding: 'utf-8', shell: false });
    writeFileSync(join(dir, 'src.txt'), 'good\n', 'utf-8');
    spawnSync('git', ['add', '-A'], { cwd: dir, encoding: 'utf-8', shell: false });
    spawnSync('git', ['commit', '-m', 'base'], { cwd: dir, encoding: 'utf-8', shell: false });
    return dir;
  }

  function buildScenarioDir(sourceRepo: string, scenario: ReliabilityScenarioConfig): string {
    const dir = makeTempDir('rel-fake-scen-');
    writeFileSync(join(dir, `${scenario.id}.json`), JSON.stringify(scenario, null, 2), 'utf-8');
    return dir;
  }

  function buildConfig(sourceRepo: string, scenarioDir: string, reportDir: string): ReliabilityConfig {
    return {
      run_id: 'fake-test',
      mode: 'fake',
      repo_slug: 'owner/repo',
      repo_path: sourceRepo,
      base_branch: 'main',
      scenario_dir: scenarioDir,
      max_repair_attempts: 2,
      real_github: false,
      real_provider: false,
      report_dir: reportDir,
    };
  }

  test('rejects fake scenario when reproduction command passes after seeded fault', async () => {
    const sourceRepo = buildSourceRepo();
    const scenario: ReliabilityScenarioConfig = {
      id: 'false-green',
      category: 'fixable',
      classification: 'TEST_ASSERTION_FAILURE',
      fixable: true,
      repair_strategy: 'apply_fix_patch',
      allowed_files: ['src.txt'],
      setup: [{ path: 'src.txt', search: 'good', replace: 'bad' }],
      fix: [{ path: 'src.txt', search: 'bad', replace: 'good' }],
      reproduction_command: ['node', '-e', 'process.exit(0)'],
      verification_commands: [['node', '-e', 'process.exit(0)']],
      expected_verdict: 'REPAIRED',
    };
    const scenarioDir = buildScenarioDir(sourceRepo, scenario);
    const reportDir = makeTempDir('rel-fake-report-');

    const { scorecard } = await runReliabilityCampaign(
      buildConfig(sourceRepo, scenarioDir, reportDir),
      {}
    );

    const result = scorecard.scenarios[0];
    assert.strictEqual(result.verdict, 'FALSE_GREEN_REJECTED');
    assert.strictEqual(result.repair_attempts, 0);
    assert.strictEqual(scorecard.false_green_count, 1);
  });

  test('repairs fake scenario when reproduction fails and verification passes', async () => {
    const sourceRepo = buildSourceRepo();
    const scenario: ReliabilityScenarioConfig = {
      id: 'normal-repair',
      category: 'fixable',
      classification: 'TEST_ASSERTION_FAILURE',
      fixable: true,
      repair_strategy: 'apply_fix_patch',
      allowed_files: ['src.txt'],
      setup: [{ path: 'src.txt', search: 'good', replace: 'bad' }],
      fix: [{ path: 'src.txt', search: 'bad', replace: 'good' }],
      reproduction_command: ['node', '-e', 'require("fs").readFileSync("src.txt","utf8").includes("bad") ? process.exit(1) : undefined'],
      verification_commands: [['node', '-e', 'require("fs").readFileSync("src.txt","utf8").includes("good") || process.exit(1)']],
      expected_verdict: 'REPAIRED',
    };
    const scenarioDir = buildScenarioDir(sourceRepo, scenario);
    const reportDir = makeTempDir('rel-fake-report-');

    const { scorecard } = await runReliabilityCampaign(
      buildConfig(sourceRepo, scenarioDir, reportDir),
      {}
    );

    const result = scorecard.scenarios[0];
    assert.strictEqual(result.verdict, 'REPAIRED');
    assert.strictEqual(result.repair_attempts, 1);
  });
});

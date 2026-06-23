import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const PROJECT_ROOT = resolve(import.meta.dirname, '..');
const DRILL_SCRIPT = join(PROJECT_ROOT, 'scripts', 'run-rollback-policy-drill.mjs');

function runDrill(envOverrides: Record<string, string> = {}, extraArgs: string[] = []): {
  status: number | null;
  stdout: string;
  stderr: string;
} {
  const env = { ...process.env, ...envOverrides };
  const result = spawnSync(
    process.execPath,
    [DRILL_SCRIPT, ...extraArgs],
    { cwd: PROJECT_ROOT, encoding: 'utf8', shell: false, env, timeout: 300000 }
  );
  return {
    status: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  };
}

function parseScenarioTable(output: string): Array<{
  name: string;
  expectedPolicy: string;
  actualStatus: string;
  localHeadStatus: string;
  remoteRefStatus: string;
  workingTreeClean: string;
  pass: boolean;
}> {
  const lines = output.split(/\r?\n/);
  const rows: Array<ReturnType<typeof parseScenarioTable>[number]> = [];
  let inTable = false;
  for (const line of lines) {
    if (line.startsWith('Scenario')) {
      inTable = true;
      continue;
    }
    if (!inTable || line.startsWith('-')) continue;
    const parts = line.split('|').map((p) => p.trim());
    if (parts.length < 7) continue;
    const [name, expectedPolicy, actualStatus, localHeadStatus, remoteRefStatus, workingTreeClean, passFail] = parts;
    rows.push({
      name,
      expectedPolicy,
      actualStatus,
      localHeadStatus,
      remoteRefStatus,
      workingTreeClean,
      pass: passFail === 'PASS',
    });
  }
  return rows;
}

describe('rollback policy drill', () => {
  it('drill script exists', () => {
    const content = readFileSync(DRILL_SCRIPT, 'utf8');
    assert.ok(content.length > 0);
    assert.ok(content.includes('runScenarioA'));
  });

  it('package.json has demo:rollback-policy-drill script', () => {
    const pkg = JSON.parse(readFileSync(join(PROJECT_ROOT, 'package.json'), 'utf8'));
    assert.ok(pkg.scripts?.['demo:rollback-policy-drill']);
    assert.ok(pkg.scripts['demo:rollback-policy-drill'].includes('run-rollback-policy-drill'));
  });

  it('drill uses local bare remotes only', () => {
    const result = runDrill({ ROLLBACK_DRILL_KEEP_TEMP: '1' });
    const output = `${result.stdout}\n${result.stderr}`;
    assert.ok(output.includes('Using local bare remotes only'), output);
    assert.ok(!output.includes('github.com'), output);
    assert.ok(!output.includes('api.moonshot.cn'), output);
  });

  it('drill refuses to run against current project repo', () => {
    const result = runDrill({}, ['--workspace', PROJECT_ROOT]);
    const output = `${result.stdout}\n${result.stderr}`;
    assert.notEqual(result.status, 0, 'expected refusal when workspace is project repo');
    assert.ok(output.includes('refuses to use a workspace inside the project repository'), output);
  });

  it('drill uses fake provider and reviewer only', () => {
    const result = runDrill({ ROLLBACK_DRILL_KEEP_TEMP: '1' });
    const output = `${result.stdout}\n${result.stderr}`;
    assert.ok(output.includes('No live provider calls'), output);
    assert.ok(!output.includes('sk-drill-fake-key'), 'fake API key should be redacted from output');
  });

  it('scenario A passes', () => {
    const result = runDrill({ ROLLBACK_DRILL_KEEP_TEMP: '1' });
    const output = `${result.stdout}\n${result.stderr}`;
    const rows = parseScenarioTable(output);
    const row = rows.find((r) => r.name.startsWith('A.'));
    assert.ok(row, 'scenario A row found');
    assert.ok(row.pass, `scenario A should pass: ${JSON.stringify(row)}`);
  });

  it('scenario B passes', () => {
    const result = runDrill({ ROLLBACK_DRILL_KEEP_TEMP: '1' });
    const rows = parseScenarioTable(`${result.stdout}\n${result.stderr}`);
    const row = rows.find((r) => r.name.startsWith('B.'));
    assert.ok(row);
    assert.ok(row.pass, `scenario B should pass: ${JSON.stringify(row)}`);
  });

  it('scenario C passes', () => {
    const result = runDrill({ ROLLBACK_DRILL_KEEP_TEMP: '1' });
    const rows = parseScenarioTable(`${result.stdout}\n${result.stderr}`);
    const row = rows.find((r) => r.name.startsWith('C.'));
    assert.ok(row);
    assert.ok(row.pass, `scenario C should pass: ${JSON.stringify(row)}`);
  });

  it('scenario D passes', () => {
    const result = runDrill({ ROLLBACK_DRILL_KEEP_TEMP: '1' });
    const rows = parseScenarioTable(`${result.stdout}\n${result.stderr}`);
    const row = rows.find((r) => r.name.startsWith('D.'));
    assert.ok(row);
    assert.ok(row.pass, `scenario D should pass: ${JSON.stringify(row)}`);
  });

  it('scenario E passes', () => {
    const result = runDrill({ ROLLBACK_DRILL_KEEP_TEMP: '1' });
    const rows = parseScenarioTable(`${result.stdout}\n${result.stderr}`);
    const row = rows.find((r) => r.name.startsWith('E.'));
    assert.ok(row);
    assert.ok(row.pass, `scenario E should pass: ${JSON.stringify(row)}`);
  });

  it('scenario F passes', () => {
    const result = runDrill({ ROLLBACK_DRILL_KEEP_TEMP: '1' });
    const rows = parseScenarioTable(`${result.stdout}\n${result.stderr}`);
    const row = rows.find((r) => r.name.startsWith('F.'));
    assert.ok(row);
    assert.ok(row.pass, `scenario F should pass: ${JSON.stringify(row)}`);
  });

  it('exits non-zero when a scenario is forced to fail', () => {
    const result = runDrill({ ROLLBACK_DRILL_FORCE_FAIL: 'A', ROLLBACK_DRILL_KEEP_TEMP: '1' });
    assert.notEqual(result.status, 0, 'expected non-zero exit when scenario A forced to fail');
    const rows = parseScenarioTable(`${result.stdout}\n${result.stderr}`);
    const rowA = rows.find((r) => r.name.startsWith('A.'));
    assert.ok(rowA);
    assert.ok(!rowA.pass, 'forced-fail scenario A should be marked FAIL');
  });

  it('redacts token-like strings in output', () => {
    const result = runDrill({ ROLLBACK_DRILL_FORCE_FAIL: 'C', ROLLBACK_DRILL_KEEP_TEMP: '1' });
    const output = `${result.stdout}\n${result.stderr}`;
    assert.ok(!output.includes('sk-reviewer-secret-1234567890'), 'raw reviewer secret should be redacted from output');
    assert.ok(output.includes('[REDACTED]'), 'redaction marker should be present');
  });

  it('cleans temp workspace by default', () => {
    const result = runDrill();
    const output = `${result.stdout}\n${result.stderr}`;
    assert.equal(result.status, 0, `drill should pass: ${output}`);
    const match = output.match(/Rollback policy drill workspace: (.+)/);
    assert.ok(match, 'workspace path should be printed');
    const workspace = match[1].trim();
    assert.ok(!existsSync(workspace), `temp workspace should be removed: ${workspace}`);
  });

  it('preserves temp workspace when ROLLBACK_DRILL_KEEP_TEMP=1', () => {
    const result = runDrill({ ROLLBACK_DRILL_KEEP_TEMP: '1' });
    const output = `${result.stdout}\n${result.stderr}`;
    assert.equal(result.status, 0, `drill should pass: ${output}`);
    const match = output.match(/Temp workspace preserved: (.+)/);
    assert.ok(match, 'preserved workspace path should be printed');
    const workspace = match[1].trim();
    assert.ok(existsSync(workspace), `temp workspace should be preserved: ${workspace}`);
  });

  it('does not change GitHub Actions workflows', () => {
    const before = spawnSync('git', ['status', '--short', '.github/workflows'], {
      cwd: PROJECT_ROOT,
      encoding: 'utf8',
      shell: false,
    }).stdout;
    const result = runDrill();
    assert.equal(result.status, 0);
    const after = spawnSync('git', ['status', '--short', '.github/workflows'], {
      cwd: PROJECT_ROOT,
      encoding: 'utf8',
      shell: false,
    }).stdout;
    assert.equal(after, before, 'workflows status should not change');
  });
});

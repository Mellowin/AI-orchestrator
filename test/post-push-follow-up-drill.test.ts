import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const PROJECT_ROOT = resolve(import.meta.dirname, '..');
const DRILL_SCRIPT = join(PROJECT_ROOT, 'scripts', 'run-post-push-follow-up-drill.mjs');

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
  stateCreated: string;
  mode: string;
  expectedPolicy: string;
  actualPolicy: string;
  repoOk: string;
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
    const [name, stateCreated, mode, expectedPolicy, actualPolicy, repoOk, passFail] = parts;
    rows.push({
      name,
      stateCreated,
      mode,
      expectedPolicy,
      actualPolicy,
      repoOk,
      pass: passFail === 'PASS',
    });
  }
  return rows;
}

describe('post-push follow-up drill', () => {
  it('drill script exists', () => {
    const content = readFileSync(DRILL_SCRIPT, 'utf8');
    assert.ok(content.length > 0);
    assert.ok(content.includes('runScenarioA'));
    assert.ok(content.includes('real-repo-follow-up'));
  });

  it('package.json has demo:post-push-follow-up-drill script', () => {
    const pkg = JSON.parse(readFileSync(join(PROJECT_ROOT, 'package.json'), 'utf8'));
    assert.ok(pkg.scripts?.['demo:post-push-follow-up-drill']);
    assert.ok(pkg.scripts['demo:post-push-follow-up-drill'].includes('run-post-push-follow-up-drill'));
  });

  it('drill uses local bare remotes only', () => {
    const result = runDrill({ FOLLOW_UP_DRILL_KEEP_TEMP: '1' });
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
    const result = runDrill({ FOLLOW_UP_DRILL_KEEP_TEMP: '1' });
    const output = `${result.stdout}\n${result.stderr}`;
    assert.ok(output.includes('No live provider calls'), output);
    assert.ok(!output.includes('sk-follow-up-drill-fake-key'), 'fake API key should be redacted from output');
  });

  for (const letter of ['A', 'B', 'C', 'D', 'E', 'F']) {
    it(`scenario ${letter} passes`, () => {
      const result = runDrill({ FOLLOW_UP_DRILL_KEEP_TEMP: '1' });
      const output = `${result.stdout}\n${result.stderr}`;
      assert.equal(result.status, 0, `drill should pass: ${output}`);
      const rows = parseScenarioTable(output);
      const row = rows.find((r) => r.name.startsWith(`${letter}.`));
      assert.ok(row, `scenario ${letter} row found`);
      assert.ok(row.pass, `scenario ${letter} should pass: ${JSON.stringify(row)}`);
    });
  }

  it('exits non-zero when a scenario is forced to fail', () => {
    const result = runDrill({ FOLLOW_UP_DRILL_FORCE_FAIL: 'A', FOLLOW_UP_DRILL_KEEP_TEMP: '1' });
    assert.notEqual(result.status, 0, 'expected non-zero exit when scenario A forced to fail');
    const rows = parseScenarioTable(`${result.stdout}\n${result.stderr}`);
    const rowA = rows.find((r) => r.name.startsWith('A.'));
    assert.ok(rowA);
    assert.ok(!rowA.pass, 'forced-fail scenario A should be marked FAIL');
  });

  it('redacts token-like strings in output', () => {
    const result = runDrill({ FOLLOW_UP_DRILL_FORCE_FAIL: 'E', FOLLOW_UP_DRILL_KEEP_TEMP: '1' });
    const output = `${result.stdout}\n${result.stderr}`;
    assert.ok(!output.includes('secret-follow-up-drill-key'), 'raw api_key value should be redacted from output');
    assert.ok(!output.includes('secret-follow-up-drill-token'), 'raw token value should be redacted from output');
    assert.ok(output.includes('[REDACTED]'), 'redaction marker should be present');
  });

  it('follow-up task file redacts token-like strings', () => {
    const result = runDrill({ FOLLOW_UP_DRILL_KEEP_TEMP: '1' });
    const output = `${result.stdout}\n${result.stderr}`;
    assert.equal(result.status, 0, `drill should pass: ${output}`);
    const workspaceMatch = output.match(/Post-push follow-up drill workspace: (.+)/);
    assert.ok(workspaceMatch, 'workspace path should be printed');
    const workspace = workspaceMatch[1].trim();
    const followUpFilePath = join(workspace, 'E', 'runs', 'drill-e', 'follow-up-drill-e-follow-up.yaml');
    assert.ok(existsSync(followUpFilePath), `follow-up file should exist: ${followUpFilePath}`);
    const content = readFileSync(followUpFilePath, 'utf8');
    assert.ok(!content.includes('secret-follow-up-drill-key'), 'raw api_key should be redacted in follow-up file');
    assert.ok(!content.includes('secret-follow-up-drill-token'), 'raw token should be redacted in follow-up file');
    assert.ok(content.includes('[REDACTED]'), 'follow-up file should contain redaction marker');
  });

  it('cleans temp workspace by default', () => {
    const result = runDrill();
    const output = `${result.stdout}\n${result.stderr}`;
    assert.equal(result.status, 0, `drill should pass: ${output}`);
    const match = output.match(/Post-push follow-up drill workspace: (.+)/);
    assert.ok(match, 'workspace path should be printed');
    const workspace = match[1].trim();
    assert.ok(!existsSync(workspace), `temp workspace should be removed: ${workspace}`);
  });

  it('preserves temp workspace when FOLLOW_UP_DRILL_KEEP_TEMP=1', () => {
    const result = runDrill({ FOLLOW_UP_DRILL_KEEP_TEMP: '1' });
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

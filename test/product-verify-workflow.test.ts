import { describe, test } from 'node:test';
import assert from 'node:assert';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import yaml from 'yaml';

const WORKFLOW_PATH = join(process.cwd(), '.github', 'workflows', 'product-verify.yml');
const README_PATH = join(process.cwd(), 'README.md');
const QUICKSTART_PATH = join(process.cwd(), 'docs', 'REAL_BLOCK_RUN_QUICKSTART.md');

function readWorkflow(): string {
  if (!existsSync(WORKFLOW_PATH)) {
    throw new Error(`Workflow file not found: ${WORKFLOW_PATH}`);
  }
  return readFileSync(WORKFLOW_PATH, 'utf-8');
}

function parseWorkflow(raw: string): unknown {
  return yaml.parse(raw);
}

describe('product verification workflow', () => {
  test('workflow file exists', () => {
    assert.ok(existsSync(WORKFLOW_PATH), 'product-verify.yml must exist');
  });

  test('workflow name includes Product verification', () => {
    const raw = readWorkflow();
    const doc = parseWorkflow(raw) as { name?: string };
    assert.ok(doc.name, 'workflow must have a name');
    assert.match(doc.name, /Product verification/);
  });

  test('workflow triggers on workflow_dispatch', () => {
    const raw = readWorkflow();
    const doc = parseWorkflow(raw) as { on?: { workflow_dispatch?: unknown } };
    assert.ok(doc.on, 'workflow must define on triggers');
    assert.ok('workflow_dispatch' in (doc.on ?? {}), 'workflow must trigger on workflow_dispatch');
  });

  test('workflow does not trigger on push', () => {
    const raw = readWorkflow();
    const doc = parseWorkflow(raw) as { on?: { push?: unknown } };
    assert.ok(!doc.on?.push, 'workflow must not trigger on push');
  });

  test('workflow does not trigger on pull_request', () => {
    const raw = readWorkflow();
    const doc = parseWorkflow(raw) as { on?: { pull_request?: unknown } };
    assert.ok(!doc.on?.pull_request, 'workflow must not trigger on pull_request');
  });

  test('workflow uses ubuntu-latest', () => {
    const raw = readWorkflow();
    const doc = parseWorkflow(raw) as { jobs?: Record<string, { 'runs-on'?: string }> };
    const job = Object.values(doc.jobs ?? {})[0];
    assert.ok(job, 'workflow must have at least one job');
    assert.strictEqual(job['runs-on'], 'ubuntu-latest');
  });

  test('workflow uses actions/checkout', () => {
    const raw = readWorkflow();
    const doc = parseWorkflow(raw) as {
      jobs?: Record<string, { steps?: Array<{ uses?: string }> }>;
    };
    const steps = Object.values(doc.jobs ?? {})[0]?.steps ?? [];
    assert.ok(
      steps.some((step) => typeof step.uses === 'string' && step.uses.startsWith('actions/checkout')),
      'workflow must use actions/checkout'
    );
  });

  test('workflow uses actions/setup-node', () => {
    const raw = readWorkflow();
    const doc = parseWorkflow(raw) as {
      jobs?: Record<string, { steps?: Array<{ uses?: string }> }>;
    };
    const steps = Object.values(doc.jobs ?? {})[0]?.steps ?? [];
    assert.ok(
      steps.some((step) => typeof step.uses === 'string' && step.uses.startsWith('actions/setup-node')),
      'workflow must use actions/setup-node'
    );
  });

  test('workflow uses Node 20', () => {
    const raw = readWorkflow();
    const doc = parseWorkflow(raw) as {
      jobs?: Record<string, { steps?: Array<{ uses?: string; with?: Record<string, unknown> }> }>;
    };
    const steps = Object.values(doc.jobs ?? {})[0]?.steps ?? [];
    const setupNode = steps.find(
      (step) => typeof step.uses === 'string' && step.uses.startsWith('actions/setup-node')
    );
    assert.ok(setupNode, 'setup-node step must exist');
    assert.strictEqual(String(setupNode.with?.['node-version']), '20');
  });

  test('workflow runs npm ci', () => {
    const raw = readWorkflow();
    const doc = parseWorkflow(raw) as {
      jobs?: Record<string, { steps?: Array<{ run?: string }> }>;
    };
    const steps = Object.values(doc.jobs ?? {})[0]?.steps ?? [];
    assert.ok(
      steps.some((step) => typeof step.run === 'string' && step.run.includes('npm ci')),
      'workflow must run npm ci'
    );
  });

  test('workflow runs npm run verify:product', () => {
    const raw = readWorkflow();
    const doc = parseWorkflow(raw) as {
      jobs?: Record<string, { steps?: Array<{ run?: string }> }>;
    };
    const steps = Object.values(doc.jobs ?? {})[0]?.steps ?? [];
    assert.ok(
      steps.some((step) => typeof step.run === 'string' && step.run.includes('npm run verify:product')),
      'workflow must run npm run verify:product'
    );
  });

  test('workflow does not contain KIMI_API_KEY', () => {
    const raw = readWorkflow();
    assert.doesNotMatch(raw, /KIMI_API_KEY/);
  });

  test('workflow does not contain secrets.', () => {
    const raw = readWorkflow();
    assert.doesNotMatch(raw, /secrets\./);
  });

  test('workflow does not contain deploy or publish commands', () => {
    const raw = readWorkflow().toLowerCase();
    assert.ok(!raw.includes('deploy'), 'workflow must not contain deploy');
    assert.ok(!raw.includes('publish'), 'workflow must not contain publish');
  });

  test('workflow does not contain git push', () => {
    const raw = readWorkflow();
    assert.doesNotMatch(raw, /git push/);
  });

  test('workflow does not contain git merge', () => {
    const raw = readWorkflow();
    assert.doesNotMatch(raw, /git merge/);
  });

  test('workflow does not contain --force', () => {
    const raw = readWorkflow();
    assert.doesNotMatch(raw, /--force/);
  });

  test('README mentions GitHub Actions product verification', () => {
    assert.ok(existsSync(README_PATH), 'README.md must exist');
    const readme = readFileSync(README_PATH, 'utf-8');
    assert.match(readme, /GitHub Actions.*product verification|product verification.*GitHub Actions/i);
  });

  test('quickstart mentions GitHub Actions product verification', () => {
    assert.ok(existsSync(QUICKSTART_PATH), 'REAL_BLOCK_RUN_QUICKSTART.md must exist');
    const doc = readFileSync(QUICKSTART_PATH, 'utf-8');
    assert.match(doc, /GitHub Actions.*product verification|product verification.*GitHub Actions/i);
  });
});

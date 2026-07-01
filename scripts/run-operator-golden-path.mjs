import { sync as spawnSync } from 'cross-spawn';

/**
 * Operator Golden Path smoke script.
 *
 * Runs only safe, local, no-API-key commands that prove the MVP pipeline is
 * healthy from a clean checkout. Stops on the first failure.
 */

const PROJECT_ROOT = process.cwd();

const STEPS = [
  {
    name: 'verify:summary',
    command: 'npm',
    args: ['run', 'verify:summary'],
    proves: 'TESTING_SUMMARY.md evidence lock is green and workflow is manual-only',
  },
  {
    name: 'typecheck',
    command: 'npm',
    args: ['run', 'typecheck'],
    proves: 'TypeScript sources type-check under strict mode',
  },
  {
    name: 'build',
    command: 'npm',
    args: ['run', 'build'],
    proves: 'Project builds cleanly to dist/',
  },
  {
    name: 'verify-testing-summary.test.ts',
    command: 'npx',
    args: ['tsx', '--test', 'test/verify-testing-summary.test.ts'],
    proves: 'Evidence verifier unit tests pass',
  },
  {
    name: 'demo:block:fake',
    command: 'npm',
    args: ['run', 'demo:block:fake'],
    proves: 'Full fake block pipeline runs end-to-end in a temp repo',
  },
  {
    name: 'demo:disposable-pilot',
    command: 'npm',
    args: ['run', 'demo:disposable-pilot'],
    proves: 'Disposable pilot prepares a throw-away repo safely without real AI',
  },
];

function runStep(step) {
  console.log(`\n=== Step: ${step.name} ===`);
  console.log(`Proves: ${step.proves}`);

  const result = spawnSync(step.command, step.args, {
    cwd: PROJECT_ROOT,
    encoding: 'utf-8',
    shell: false,
    stdio: 'inherit',
  });

  if (result.status !== 0) {
    console.error(`\n[FAIL] Step "${step.name}" failed with exit code ${result.status ?? 'unknown'}`);
    return false;
  }

  console.log(`[PASS] Step "${step.name}" passed.`);
  return true;
}

function main() {
  console.log('AI Orchestrator — Operator Golden Path');
  console.log('This script runs safe, local, no-API-key smoke checks.');
  console.log('It will stop on the first failure.');

  for (const step of STEPS) {
    if (!runStep(step)) {
      process.exit(1);
    }
  }

  console.log('\n=== Operator Golden Path Summary ===');
  console.log(`All ${STEPS.length} steps passed.`);
  for (const step of STEPS) {
    console.log(`- ${step.name}`);
  }
  console.log('No real AI provider was called.');
  console.log('No history-altering git operations were performed on this repository.');
  process.exit(0);
}

main();

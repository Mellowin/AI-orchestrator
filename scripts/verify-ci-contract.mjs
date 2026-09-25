#!/usr/bin/env node
/**
 * Deterministic CI contract validator.
 *
 * Fails (exit 1) when a repository workflow file used by product CI invokes
 * `npm run <script>` for a script that does not exist in package.json, or when
 * a package.json script references a repository file that does not exist.
 *
 * This catches a broken repository CI contract BEFORE a PR reaches remote CI,
 * preventing "product verification green but every PR CI red" drift.
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateCiContract } from './ci-contract-lib.mjs';

const __filename = fileURLToPath(import.meta.url);
const PROJECT_ROOT = resolve(dirname(__filename), '..');

const repoRoot = process.argv[2] ? resolve(process.argv[2]) : PROJECT_ROOT;

const report = validateCiContract(repoRoot);

console.log(`[verify-ci-contract] Repository: ${repoRoot}`);
console.log(`[verify-ci-contract] Workflow npm script references: ${report.workflow_npm_scripts.length}`);
console.log(`[verify-ci-contract] Package script file targets: ${report.script_target_files.length}`);

if (report.ok) {
  console.log('[verify-ci-contract] CI contract OK: every workflow npm script exists in package.json and every referenced file exists.');
  process.exit(0);
}

console.error(`[verify-ci-contract] CI CONTRACT BROKEN: ${report.violations.length} violation(s)`);
for (const violation of report.violations) {
  console.error(`[verify-ci-contract] - ${violation.message}`);
}
process.exit(1);

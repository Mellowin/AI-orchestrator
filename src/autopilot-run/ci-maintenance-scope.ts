/**
 * Deterministic CI-maintenance scope for autonomous CI repair.
 *
 * TASK WRITABLE SCOPE (mission allowed_files ∪ task allowed_files) is kept
 * strictly separate from SYSTEM-AUTHORIZED CI MAINTENANCE SCOPE. The
 * maintenance expansion is derived ONLY from deterministic diagnosis
 * evidence — never from provider suggestions — and is classification-bound:
 *
 *   MISSING_NPM_SCRIPT -> package.json + scripts/** (bounded repository
 *                         maintenance). Workflow files are NEVER authorized:
 *                         a broken workflow command does not authorize
 *                         workflow edits.
 *
 * Any other classification yields an empty maintenance scope: repair stays
 * within the task writable scope alone.
 */

import type { DiagnoseCiClassification } from '../diagnose-ci/types.js';

export interface CiMaintenanceScope {
  files: string[];
  evidence: string;
}

const EMPTY_SCOPE: CiMaintenanceScope = { files: [], evidence: '' };

/** Files that remain protected regardless of classification. */
export const ALWAYS_DENIED_FILES = ['.env*', '.github/workflows/**'];

/**
 * Resolve the deterministic maintenance scope for a CI classification.
 *
 * @param classification Diagnosis classification from diagnose-ci.
 * @param missingNpmScripts Exact npm script names proven missing by the
 *   failed-job logs (deterministic diagnosis evidence).
 */
export function resolveCiMaintenanceScope(
  classification: DiagnoseCiClassification | null,
  missingNpmScripts: string[] = []
): CiMaintenanceScope {
  if (classification !== 'MISSING_NPM_SCRIPT') {
    return EMPTY_SCOPE;
  }

  const evidenceParts = [
    'Diagnosis classification: MISSING_NPM_SCRIPT (deterministic, from failed-job logs).',
  ];
  if (missingNpmScripts.length > 0) {
    evidenceParts.push(
      `Failed jobs invoked npm scripts that do not exist in package.json: ${missingNpmScripts
        .map((s) => `"${s}"`)
        .join(', ')}.`
    );
  }
  evidenceParts.push(
    'Authorized repository-maintenance files: package.json, scripts/** (bounded).',
    'Workflow files (.github/workflows/**) are NOT authorized: a broken workflow command ' +
      'does not authorize workflow edits (CI weakening protection).'
  );

  return {
    files: ['package.json', 'scripts/**'],
    evidence: evidenceParts.join('\n'),
  };
}

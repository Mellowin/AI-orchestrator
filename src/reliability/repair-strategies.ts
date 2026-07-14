import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ReliabilityScenarioConfig, ReliabilityScenarioPatch } from './types.js';
import { applyScenarioPatches } from './patch-scenario.js';

export interface RepairStrategyResult {
  ok: boolean;
  reason: string;
  files: string[];
}

export function runRepairStrategy(
  scenario: ReliabilityScenarioConfig,
  repoPath: string
): RepairStrategyResult {
  const strategy = scenario.repair_strategy ?? 'apply_fix_patch';

  switch (strategy) {
    case 'testing_summary_lock':
      return repairTestingSummaryLock(repoPath, scenario);
    case 'apply_fix_patch':
      return applyFixPatch(scenario, repoPath);
    case 'no_op':
      return { ok: true, reason: 'No repair required for this scenario', files: [] };
    default:
      return { ok: false, reason: `Unknown repair strategy: ${strategy}`, files: [] };
  }
}

function applyFixPatch(scenario: ReliabilityScenarioConfig, repoPath: string): RepairStrategyResult {
  if (!scenario.fix || scenario.fix.length === 0) {
    return { ok: false, reason: 'No fix patch defined for scenario', files: [] };
  }
  try {
    applyScenarioPatches(repoPath, scenario.fix);
    return {
      ok: true,
      reason: 'Applied deterministic fix patch',
      files: scenario.fix.map((p) => p.path),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: `Failed to apply fix patch: ${message}`, files: [] };
  }
}

function repairTestingSummaryLock(repoPath: string, scenario: ReliabilityScenarioConfig): RepairStrategyResult {
  const summaryPath = join(repoPath, 'TESTING_SUMMARY.md');
  if (!existsSync(summaryPath)) {
    return { ok: false, reason: 'TESTING_SUMMARY.md not found', files: [] };
  }

  const verifyResult = spawnSync('node', ['scripts/verify-testing-summary.mjs'], {
    cwd: repoPath,
    encoding: 'utf-8',
    shell: false,
  });

  if (verifyResult.status === 0) {
    return { ok: true, reason: 'TESTING_SUMMARY.md already valid', files: [] };
  }

  const headResult = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: repoPath,
    encoding: 'utf-8',
    shell: false,
  });
  if (headResult.status !== 0) {
    return { ok: false, reason: 'Failed to read HEAD SHA', files: [] };
  }
  const headSha = headResult.stdout.trim();

  let content = readFileSync(summaryPath, 'utf-8');
  const shaPattern = /[0-9a-f]{40}/gi;
  const matches = content.match(shaPattern);
  if (!matches || matches.length === 0) {
    return { ok: false, reason: 'No SHA found in TESTING_SUMMARY.md', files: [] };
  }

  // Replace all full SHAs in the latest verification section only.
  const latestSectionMatch = content.match(/\*\*Last verified:\*\*[\s\S]*?(?=## Documentation stages)/);
  if (!latestSectionMatch) {
    return { ok: false, reason: 'Could not locate latest verification section', files: [] };
  }
  const latestSection = latestSectionMatch[0];
  const updatedSection = latestSection.replace(shaPattern, headSha);
  content = content.replace(latestSection, updatedSection);

  writeFileSync(summaryPath, content, 'utf-8');

  const reverifyResult = spawnSync('node', ['scripts/verify-testing-summary.mjs'], {
    cwd: repoPath,
    encoding: 'utf-8',
    shell: false,
  });

  if (reverifyResult.status !== 0) {
    return { ok: false, reason: 'Summary repair did not pass verification', files: ['TESTING_SUMMARY.md'] };
  }

  return {
    ok: true,
    reason: `Updated TESTING_SUMMARY.md Last verified commit to ${headSha}`,
    files: ['TESTING_SUMMARY.md'],
  };
}

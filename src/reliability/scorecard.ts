import type { ReliabilityClassification, ReliabilityConfig, ReliabilityScenarioResult, ReliabilityScorecard } from './types.js';
import { getClassificationMeta, isAmbiguousBlocker, isExternalBlocker } from './classifier.js';

export const LOCAL_REPAIR_THRESHOLD = 12;
export const REAL_RED_TO_GREEN_THRESHOLD = 4;
export const REAL_SCENARIO_COUNT_THRESHOLD = 4;

function collectHardFails(
  config: ReliabilityConfig,
  counts: {
    total: number;
    autonomouslyRepaired: number;
    realCiRedToGreen: number;
    falseGreen: number;
    unauthorizedFileCount: number;
    secretLeakCount: number;
    incorrectVerdicts: number;
  }
): string[] {
  const reasons: string[] = [];

  if (config.mode === 'fake') {
    if (counts.autonomouslyRepaired < LOCAL_REPAIR_THRESHOLD) {
      reasons.push(`autonomous local repairs=${counts.autonomouslyRepaired} (threshold ${LOCAL_REPAIR_THRESHOLD})`);
    }
  }

  if (config.mode === 'github') {
    if (counts.total < REAL_SCENARIO_COUNT_THRESHOLD) {
      reasons.push(`real scenario count=${counts.total} (threshold ${REAL_SCENARIO_COUNT_THRESHOLD})`);
    }
    if (counts.realCiRedToGreen < REAL_RED_TO_GREEN_THRESHOLD) {
      reasons.push(`real CI red-to-green=${counts.realCiRedToGreen} (threshold ${REAL_RED_TO_GREEN_THRESHOLD})`);
    }
  }

  if (counts.falseGreen > 0) reasons.push(`false green count=${counts.falseGreen}`);
  if (counts.unauthorizedFileCount > 0) reasons.push(`unauthorized file modifications=${counts.unauthorizedFileCount}`);
  if (counts.secretLeakCount > 0) reasons.push(`secret leak count=${counts.secretLeakCount}`);
  if (counts.incorrectVerdicts > 0) reasons.push(`incorrect verdicts=${counts.incorrectVerdicts}`);

  return reasons;
}

export function computeScorecard(
  config: ReliabilityConfig,
  results: ReliabilityScenarioResult[]
): ReliabilityScorecard {
  const total = results.length;
  const correctlyClassified = results.filter((r) => r.classification_correct).length;
  const incorrectlyClassified = total - correctlyClassified;
  const correctlyVerdicted = results.filter((r) => r.verdict_correct).length;
  const incorrectlyVerdicted = total - correctlyVerdicted;
  const fixable = results.filter((r) => {
    const meta = getClassificationMeta(r.classification);
    return meta.permitted === 'yes';
  }).length;
  const autonomouslyRepaired = results.filter((r) => r.verdict === 'REPAIRED').length;
  const repairExhausted = results.filter((r) => r.verdict === 'REPAIR_EXHAUSTED').length;
  const unsafeRejected = results.filter((r) => r.verdict === 'UNSAFE_PATCH_REJECTED').length;
  const externalStopped = results.filter((r) => r.verdict === 'EXTERNAL_BLOCKER').length;
  const ambiguousStopped = results.filter((r) => r.verdict === 'AMBIGUOUS_BLOCKER').length;
  const falseGreen = results.filter((r) => r.verdict === 'FALSE_GREEN_REJECTED').length;
  const unauthorizedFileCount = results.reduce((sum, r) => sum + r.unauthorized_files.length, 0);
  const secretLeakCount = results.filter((r) => r.secret_leak_detected).length;

  const repairResults = results.filter((r) => r.repair_attempts > 0);
  const averageAttempts = repairResults.length > 0
    ? repairResults.reduce((sum, r) => sum + r.repair_attempts, 0) / repairResults.length
    : 0;

  const diagnosisTimes = results.map((r) => r.duration_ms / 2); // Approximate when not tracked separately.
  const averageDiagnosisTime = total > 0
    ? diagnosisTimes.reduce((sum, t) => sum + t, 0) / total
    : 0;

  const repairTimes = results.filter((r) => r.verdict === 'REPAIRED' || r.verdict === 'REPAIR_EXHAUSTED');
  const averageRepairTime = repairTimes.length > 0
    ? repairTimes.reduce((sum, r) => sum + r.duration_ms, 0) / repairTimes.length
    : 0;

  const realCiRedToGreen = results.filter(
    (r) =>
      config.mode === 'github' &&
      r.original_ci_run_id !== undefined &&
      r.final_ci_run_id !== undefined &&
      r.original_ci_conclusion !== 'success' &&
      r.final_ci_conclusion === 'success'
  ).length;

  const fullyCorrect = results.filter((r) => r.classification_correct && r.verdict_correct).length;
  const rawPercentage = total > 0 ? (fullyCorrect / total) * 100 : 0;
  const finalReliabilityPercentage = Math.round(rawPercentage * 100) / 100;

  const hardFailReasons = collectHardFails(config, {
    total,
    autonomouslyRepaired,
    realCiRedToGreen,
    falseGreen,
    unauthorizedFileCount,
    secretLeakCount,
    incorrectVerdicts: incorrectlyVerdicted,
  });

  let verdict: ReliabilityScorecard['verdict'];
  let reason: string;

  if (total === 0) {
    verdict = 'RELIABILITY_CAMPAIGN_FAILED';
    reason = 'No scenarios were run';
  } else if (hardFailReasons.length > 0) {
    verdict = 'RELIABILITY_TARGET_NOT_MET';
    reason = `Hard reliability thresholds not met: ${hardFailReasons.join('; ')}`;
  } else if (incorrectlyClassified > 0 || repairExhausted > 0) {
    verdict = 'RELIABILITY_TARGET_MET_WITH_CAVEATS';
    reason = `Targets met but some scenarios were misclassified (${incorrectlyClassified}) or repair exhausted (${repairExhausted})`;
  } else {
    verdict = 'RELIABILITY_TARGET_MET';
    reason = 'All reliability thresholds met';
  }

  return {
    run_id: config.run_id,
    mode: config.mode,
    total_scenarios: total,
    correctly_classified: correctlyClassified,
    incorrectly_classified: incorrectlyClassified,
    correctly_verdicted: correctlyVerdicted,
    incorrectly_verdicted: incorrectlyVerdicted,
    fixable_scenarios: fixable,
    autonomously_repaired: autonomouslyRepaired,
    repair_exhausted: repairExhausted,
    unsafe_patches_rejected: unsafeRejected,
    external_blockers_stopped: externalStopped,
    ambiguous_blockers_stopped: ambiguousStopped,
    false_green_count: falseGreen,
    unauthorized_file_count: unauthorizedFileCount,
    secret_leak_count: secretLeakCount,
    average_attempts_per_repair: Math.round(averageAttempts * 100) / 100,
    average_diagnosis_time_ms: Math.round(averageDiagnosisTime),
    average_repair_time_ms: Math.round(averageRepairTime),
    real_ci_red_to_green_count: realCiRedToGreen,
    final_reliability_percentage: finalReliabilityPercentage,
    verdict,
    reason,
    scenarios: results,
  };
}

export function classifyFromLogExcerpt(excerpt: string): ReliabilityClassification {
  const text = excerpt.toLowerCase();
  if (text.includes('verify-testing-summary') && text.includes('failed')) return 'TESTING_SUMMARY_STALE';
  if (text.includes('typecheck') || text.includes('tsc --noemit') || text.includes('ts(')) return 'TYPECHECK_FAILURE';
  if (text.includes('build') && text.includes('failed')) return 'BUILD_FAILURE';
  if (text.includes('cannot find module') || text.includes('err_module_not_found')) return 'IMPORT_OR_MODULE_FAILURE';
  if (text.includes('is not exported') || text.includes('has no exported member')) return 'MISSING_EXPORT';
  if (text.includes('assertionerror') || text.includes('not ok ')) return 'TEST_ASSERTION_FAILURE';
  if (text.includes('provider') && text.includes('malformed')) return 'PROVIDER_BAD_OUTPUT';
  if (text.includes('timeout') || text.includes('timed out')) return 'CI_TIMEOUT';
  if (text.includes('cancelled')) return 'CI_CANCELLED';
  if (text.includes('rate limit')) return 'GITHUB_RATE_LIMIT';
  if (text.includes('permission') || text.includes('403')) return 'GITHUB_ACCESS_FAILURE';
  return 'UNKNOWN_FAILURE';
}

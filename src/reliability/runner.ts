import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type {
  ReliabilityClassification,
  ReliabilityConfig,
  ReliabilityRunOptions,
  ReliabilityCampaignState,
  ReliabilityScenarioConfig,
  ReliabilityScenarioResult,
} from './types.js';
import { loadReliabilityScenarios } from './scenario-loader.js';
import { runRepairStrategy } from './repair-strategies.js';
import { checkRepairSafety } from './repair-safety.js';
import { buildRepairContext, getChangedFiles, getDiffSummary } from './repair-context.js';
import { computeScorecard } from './scorecard.js';
import { getClassificationMeta, isExternalBlocker, isAmbiguousBlocker, isRepairPermitted } from './classifier.js';
import { redactSecrets } from '../diagnose-ci/redaction.js';
import {
  nowIso,
  setupScenarioRepo,
  runLocalChecks,
  classifyScenario,
  determineVerdict,
  finishScenario,
  writeScenarioReport,
  writeScorecard,
  runGitHubScenario,
  loadCampaignState,
  saveCampaignState,
} from './runner-helpers.js';

async function runFakeScenario(
  scenario: ReliabilityScenarioConfig,
  config: ReliabilityConfig,
  reportDir: string,
  options: ReliabilityRunOptions
): Promise<ReliabilityScenarioResult> {
  const startedAt = nowIso();
  const startTime = Date.now();
  const spawnFn = options.spawnFn ?? spawnSync;
  const tempRoot = config.temp_root ?? resolve(reportDir, 'temp');
  if (!existsSync(tempRoot)) {
    mkdirSync(tempRoot, { recursive: true });
  }

  let repoPath: string | undefined;
  const repairCommits: string[] = [];
  let classification: ReliabilityClassification = scenario.classification;
  let repairOk = false;
  let checksOk = false;
  let unsafeDetected = false;
  let secretLeak = false;
  let unauthorizedFiles: string[] = [];
  let failureReason: string | undefined;
  let repairAttemptCount = 0;

  try {
    const setup = setupScenarioRepo(scenario, config.repo_path, config.base_branch, tempRoot, spawnFn);
    repoPath = setup.repoPath;

    const reproduction = scenario.reproduction_command;
    let logOutput = '';
    if (reproduction) {
      const [cmd, ...args] = reproduction;
      const result = runLocalChecks(repoPath, [[cmd, ...args]], spawnFn);
      logOutput = result.ok ? '' : result.output;
    }

    classification = classifyScenario(scenario, logOutput);
    const meta = getClassificationMeta(classification);

    if (isExternalBlocker(classification) || isAmbiguousBlocker(classification) || !scenario.fixable) {
      return finishScenario({
        scenario,
        classification,
        verdict: meta.finalVerdictWhenBlocked,
        repairCommits,
        unsafeDetected,
        unauthorizedFiles,
        secretLeak,
        failureReason: `Classification ${classification} does not permit autonomous repair`,
        repairAttemptCount,
        startedAt,
        startTime,
      });
    }

    const maxAttempts = Math.min(config.max_repair_attempts, meta.maxAttempts);
    while (repairAttemptCount < maxAttempts) {
      repairAttemptCount += 1;

      const repairResult = runRepairStrategy(scenario, repoPath);
      if (!repairResult.ok) {
        failureReason = repairResult.reason;
        continue;
      }

      const safety = checkRepairSafety(
        repairResult.files.map((path) => ({ path, content: readFileSync(resolve(repoPath!, path), 'utf-8') })),
        scenario.allowed_files,
        false
      );
      if (safety.length > 0) {
        unsafeDetected = true;
        failureReason = `Unsafe patch rejected: ${safety.map((v) => v.message).join('; ')}`;
        break;
      }

      // Stage and commit repair.
      const addResult = spawnFn('git', ['add', '-A'], { cwd: repoPath, encoding: 'utf-8', shell: false });
      if (addResult.status === 0) {
        const commitResult = spawnFn(
          'git',
          ['commit', '-m', `docs: refresh evidence lock after autonomous repair`],
          { cwd: repoPath, encoding: 'utf-8', shell: false }
        );
        if (commitResult.status === 0) {
          const shaResult = spawnFn('git', ['rev-parse', 'HEAD'], { cwd: repoPath, encoding: 'utf-8', shell: false });
          if (shaResult.status === 0) {
            repairCommits.push(shaResult.stdout.trim());
          }
        }
      }

      const checkResult = runLocalChecks(repoPath, scenario.verification_commands, spawnFn);
      if (checkResult.ok) {
        repairOk = true;
        checksOk = true;
        break;
      } else {
        failureReason = checkResult.output;
      }
    }

    // Build repair context for reporting (not used for deterministic fake repairs).
    const context = buildRepairContext({
      mission_goal: `Repair scenario ${scenario.id}`,
      branch: setup.branch,
      classification,
      confidence: 'high',
      log_excerpt: logOutput,
      allowed_files: scenario.allowed_files,
      forbidden_files: scenario.denied_files,
      changed_files: getChangedFiles(repoPath, config.base_branch),
      diff_summary: getDiffSummary(repoPath, config.base_branch),
      reproduction_command: scenario.reproduction_command,
      verification_command: scenario.verification_commands?.[0],
    });
    const contextDir = resolve(reportDir, 'scenarios', scenario.id);
    if (!existsSync(contextDir)) mkdirSync(contextDir, { recursive: true });
    writeFileSync(resolve(contextDir, 'repair-context.md'), context.markdown, 'utf-8');
    writeFileSync(resolve(contextDir, 'repair-context.json'), JSON.stringify(context.json, null, 2), 'utf-8');

    const verdict = determineVerdict(scenario, classification, repairOk, checksOk, unsafeDetected, unauthorizedFiles, secretLeak);

    return finishScenario({
      scenario,
      classification,
      verdict,
      repairCommits,
      unsafeDetected,
      unauthorizedFiles,
      secretLeak,
      failureReason,
      repairAttemptCount,
      startedAt,
      startTime,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return finishScenario({
      scenario,
      classification,
      verdict: 'REPAIR_EXHAUSTED',
      repairCommits,
      unsafeDetected,
      unauthorizedFiles,
      secretLeak,
      failureReason: message,
      repairAttemptCount,
      startedAt,
      startTime,
    });
  } finally {
    if (repoPath && repoPath.startsWith(tempRoot)) {
      try {
        rmSync(repoPath, { recursive: true, force: true });
      } catch {
        // ignore cleanup failure
      }
    }
  }
}

export async function runReliabilityCampaign(
  config: ReliabilityConfig,
  options: ReliabilityRunOptions = {}
): Promise<{ scorecard: ReturnType<typeof computeScorecard>; reportDir: string }> {
  const startedAt = nowIso();
  const reportDir = resolve(config.report_dir, config.run_id);
  if (!existsSync(reportDir)) {
    mkdirSync(reportDir, { recursive: true });
  }

  let campaignState: ReliabilityCampaignState | null = null;
  if (options.resume) {
    campaignState = loadCampaignState(reportDir);
    if (!campaignState) {
      throw new Error(`No campaign state found to resume for run ${config.run_id}`);
    }
    if (campaignState.run_id !== config.run_id) {
      throw new Error(
        `Resume run_id mismatch: state=${campaignState.run_id}, config=${config.run_id}`
      );
    }
  }
  if (!campaignState) {
    campaignState = {
      run_id: config.run_id,
      mode: config.mode,
      started_at: startedAt,
      updated_at: startedAt,
      scenarios: [],
    };
    saveCampaignState(reportDir, campaignState);
  }

  let scenarios = loadReliabilityScenarios(config.scenario_dir);
  if (config.scenario_filter && config.scenario_filter.length > 0) {
    const allowed = new Set(config.scenario_filter);
    scenarios = scenarios.filter((s) => allowed.has(s.id));
  }
  const results: ReliabilityScenarioResult[] = [];

  for (const scenario of scenarios) {
    if (config.mode === 'fake') {
      const result = await runFakeScenario(scenario, config, reportDir, options);
      results.push(result);
      writeScenarioReport(reportDir, scenario.id, result);
    } else {
      const existing = campaignState.scenarios.find((s) => s.scenario_id === scenario.id);
      if (existing?.status === 'done' && existing.result) {
        results.push(existing.result);
        writeScenarioReport(reportDir, scenario.id, existing.result);
        continue;
      }
      const result = await runGitHubScenario(scenario, config, reportDir, options, campaignState, (state) =>
        saveCampaignState(reportDir, state)
      );
      const idx = campaignState.scenarios.findIndex((s) => s.scenario_id === scenario.id);
      const finalState = {
        ...(idx >= 0 ? campaignState.scenarios[idx] : { scenario_id: scenario.id, status: 'done' as const }),
        status: 'done' as const,
        result,
      };
      if (idx >= 0) {
        campaignState.scenarios[idx] = finalState;
      } else {
        campaignState.scenarios.push(finalState);
      }
      campaignState.updated_at = nowIso();
      saveCampaignState(reportDir, campaignState);
      results.push(result);
      writeScenarioReport(reportDir, scenario.id, result);
    }
  }

  const scorecard = computeScorecard(config, results);
  writeScorecard(reportDir, scorecard);
  writeFileSync(
    resolve(reportDir, 'campaign.json'),
    JSON.stringify(
      {
        run_id: config.run_id,
        mode: config.mode,
        started_at: startedAt,
        finished_at: nowIso(),
        scenario_count: scenarios.length,
        scorecard,
      },
      null,
      2
    ),
    'utf-8'
  );

  return { scorecard, reportDir };
}

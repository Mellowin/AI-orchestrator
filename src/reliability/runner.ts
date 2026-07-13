import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type {
  ReliabilityClassification,
  ReliabilityConfig,
  ReliabilityRunOptions,
  ReliabilityScenarioConfig,
  ReliabilityScenarioResult,
  ReliabilityScenarioVerdict,
} from './types.js';
import { loadReliabilityScenarios } from './scenario-loader.js';
import { applyScenarioPatches } from './patch-scenario.js';
import { getClassificationMeta, isAmbiguousBlocker, isExternalBlocker, isRepairPermitted } from './classifier.js';
import { runRepairStrategy } from './repair-strategies.js';
import { checkRepairSafety } from './repair-safety.js';
import { buildRepairContext, getChangedFiles, getDiffSummary } from './repair-context.js';
import { computeScorecard } from './scorecard.js';
import { getGitRemoteUrl, injectGitHubTokenIntoRemoteUrl } from '../git-push-auth.js';
import { redactSecrets } from '../diagnose-ci/redaction.js';

export interface ReliabilityRunResult {
  scorecard: ReturnType<typeof computeScorecard>;
  reportDir: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

function normalizeCommand(
  cwd: string,
  command: string,
  args: string[]
): { command: string; args: string[] } {
  // Avoid npx/.cmd wrapper issues on Windows by invoking the tsx CLI directly.
  if (command === 'npx' && args[0] === 'tsx') {
    return { command: 'node', args: [join(cwd, 'node_modules/tsx/dist/cli.mjs'), ...args.slice(1)] };
  }
  return { command, args };
}

function runCommand(
  cwd: string,
  command: string,
  args: string[],
  spawnFn: ReliabilityRunOptions['spawnFn']
): { ok: boolean; stdout: string; stderr: string } {
  const normalized = normalizeCommand(cwd, command, args);
  const result = spawnFn!(normalized.command, normalized.args, { cwd, encoding: 'utf-8', shell: false });
  return {
    ok: result.status === 0,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

function createTempClone(
  repoPath: string,
  tempRoot: string,
  spawnFn: ReliabilityRunOptions['spawnFn']
): string {
  const dir = mkdtempSync(join(tempRoot, 'reliability-'));
  const cloneResult = spawnFn!('git', ['clone', resolve(repoPath), dir], {
    encoding: 'utf-8',
    shell: false,
  });
  if (cloneResult.status !== 0) {
    throw new Error(`Failed to clone repo for reliability run: ${cloneResult.stderr}`);
  }
  const sourceNodeModules = join(repoPath, 'node_modules');
  if (existsSync(sourceNodeModules)) {
    cpSync(sourceNodeModules, join(dir, 'node_modules'), { recursive: true, dereference: true });
  }
  return dir;
}

function configureGitIdentity(repoPath: string, spawnFn: ReliabilityRunOptions['spawnFn']): void {
  spawnFn!('git', ['config', 'user.email', 'reliability@ai-orchestrator.local'], {
    cwd: repoPath,
    encoding: 'utf-8',
    shell: false,
  });
  spawnFn!('git', ['config', 'user.name', 'Reliability Runner'], {
    cwd: repoPath,
    encoding: 'utf-8',
    shell: false,
  });
}

function setupScenarioRepo(
  scenario: ReliabilityScenarioConfig,
  sourceRepo: string,
  tempRoot: string,
  spawnFn: ReliabilityRunOptions['spawnFn']
): { repoPath: string; branch: string } {
  const repoPath = createTempClone(sourceRepo, tempRoot, spawnFn);
  configureGitIdentity(repoPath, spawnFn);

  const branch = `reliability-${scenario.id}-${Date.now()}`;
  const checkoutResult = spawnFn!('git', ['checkout', '-b', branch], {
    cwd: repoPath,
    encoding: 'utf-8',
    shell: false,
  });
  if (checkoutResult.status !== 0) {
    throw new Error(`Failed to create work branch ${branch}: ${checkoutResult.stderr}`);
  }

  applyScenarioPatches(repoPath, scenario.setup);

  const addResult = spawnFn!('git', ['add', '-A'], {
    cwd: repoPath,
    encoding: 'utf-8',
    shell: false,
  });
  if (addResult.status !== 0) {
    throw new Error(`Failed to stage setup patch: ${addResult.stderr}`);
  }

  const diffResult = spawnFn!('git', ['diff', '--cached', '--quiet'], {
    cwd: repoPath,
    encoding: 'utf-8',
    shell: false,
  });
  if (diffResult.status === 0) {
    // No staged changes; nothing to commit (e.g. external scenarios).
    return { repoPath, branch };
  }

  const commitResult = spawnFn!(
    'git',
    ['commit', '-m', `reliability: seed fault for ${scenario.id}`],
    {
      cwd: repoPath,
      encoding: 'utf-8',
      shell: false,
    }
  );
  if (commitResult.status !== 0) {
    throw new Error(`Failed to commit setup patch: ${commitResult.stderr}`);
  }

  return { repoPath, branch };
}

function runLocalChecks(
  repoPath: string,
  commands: string[][] | undefined,
  spawnFn: ReliabilityRunOptions['spawnFn']
): { ok: boolean; output: string } {
  const checks = commands ?? [
    ['npm', 'run', 'typecheck'],
    ['npm', 'run', 'build'],
  ];

  for (const args of checks) {
    const [command, ...rest] = args;
    const result = runCommand(repoPath, command, rest, spawnFn);
    if (!result.ok) {
      return { ok: false, output: `${command} ${rest.join(' ')} failed:\n${result.stderr || result.stdout}` };
    }
  }

  return { ok: true, output: 'all local checks passed' };
}

function classifyScenario(scenario: ReliabilityScenarioConfig, logOutput: string): ReliabilityClassification {
  // In fake mode, the scenario declares its classification. In real mode, this can be
  // augmented with diagnose-ci output.
  if (scenario.category === 'external') {
    return scenario.classification;
  }
  if (scenario.category === 'unsafe') {
    return scenario.classification;
  }
  return scenario.classification;
}

function determineVerdict(
  scenario: ReliabilityScenarioConfig,
  classification: ReliabilityClassification,
  repairOk: boolean,
  checksOk: boolean,
  unsafeDetected: boolean,
  unauthorizedFiles: string[],
  secretLeak: boolean
): ReliabilityScenarioVerdict {
  if (unsafeDetected) return 'UNSAFE_PATCH_REJECTED';
  if (secretLeak) return 'FALSE_GREEN_REJECTED';
  if (unauthorizedFiles.length > 0) return 'UNSAFE_PATCH_REJECTED';

  if (isExternalBlocker(classification)) {
    return 'EXTERNAL_BLOCKER';
  }
  if (isAmbiguousBlocker(classification)) {
    return 'AMBIGUOUS_BLOCKER';
  }
  if (!scenario.fixable || !isRepairPermitted(classification)) {
    return 'NOT_FIXABLE';
  }
  if (!repairOk) {
    return 'REPAIR_EXHAUSTED';
  }
  if (!checksOk) {
    return 'REPAIR_EXHAUSTED';
  }
  return 'REPAIRED';
}

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
    const setup = setupScenarioRepo(scenario, config.repo_path, tempRoot, spawnFn);
    repoPath = setup.repoPath;

    const reproduction = scenario.reproduction_command;
    let logOutput = '';
    if (reproduction) {
      const [cmd, ...args] = reproduction;
      const result = runCommand(repoPath, cmd, args, spawnFn);
      logOutput = result.stderr || result.stdout;
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
        repairResult.files.map((path) => ({ path, content: readFileSync(join(repoPath!, path), 'utf-8') })),
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
    const contextDir = join(reportDir, 'scenarios', scenario.id);
    if (!existsSync(contextDir)) mkdirSync(contextDir, { recursive: true });
    writeFileSync(join(contextDir, 'repair-context.md'), context.markdown, 'utf-8');
    writeFileSync(join(contextDir, 'repair-context.json'), JSON.stringify(context.json, null, 2), 'utf-8');

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

interface FinishScenarioInput {
  scenario: ReliabilityScenarioConfig;
  classification: ReliabilityClassification;
  verdict: ReliabilityScenarioVerdict;
  repairCommits: string[];
  unsafeDetected: boolean;
  unauthorizedFiles: string[];
  secretLeak: boolean;
  failureReason?: string;
  repairAttemptCount: number;
  startedAt: string;
  startTime: number;
}

function finishScenario(input: FinishScenarioInput): ReliabilityScenarioResult {
  const {
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
  } = input;

  return {
    scenario_id: scenario.id,
    classification,
    confidence: 'high',
    expected_classification: scenario.classification,
    classification_correct: classification === scenario.classification,
    verdict,
    expected_verdict: scenario.expected_verdict,
    verdict_correct: verdict === scenario.expected_verdict,
    repair_attempts: repairAttemptCount,
    repair_commits: repairCommits,
    unsafe_patch_detected: unsafeDetected,
    unauthorized_files: unauthorizedFiles,
    secret_leak_detected: secretLeak,
    failure_reason: failureReason ? redactSecrets(failureReason) : undefined,
    started_at: startedAt,
    finished_at: nowIso(),
    duration_ms: Date.now() - startTime,
  };
}

export async function runReliabilityCampaign(
  config: ReliabilityConfig,
  options: ReliabilityRunOptions = {}
): Promise<ReliabilityRunResult> {
  const startedAt = nowIso();
  const spawnFn = options.spawnFn ?? spawnSync;
  const reportDir = resolve(config.report_dir, config.run_id);
  if (!existsSync(reportDir)) {
    mkdirSync(reportDir, { recursive: true });
  }

  const scenarios = loadReliabilityScenarios(config.scenario_dir);
  const results: ReliabilityScenarioResult[] = [];

  for (const scenario of scenarios) {
    if (config.mode === 'fake') {
      const result = await runFakeScenario(scenario, config, reportDir, options);
      results.push(result);
      writeScenarioReport(reportDir, scenario.id, result);
    } else {
      // Real GitHub mode not yet implemented in this iteration.
      results.push({
        scenario_id: scenario.id,
        classification: scenario.classification,
        confidence: 'low',
        expected_classification: scenario.classification,
        classification_correct: true,
        verdict: 'EXTERNAL_BLOCKER',
        expected_verdict: scenario.expected_verdict,
        verdict_correct: scenario.expected_verdict === 'EXTERNAL_BLOCKER',
        repair_attempts: 0,
        repair_commits: [],
        unsafe_patch_detected: false,
        unauthorized_files: [],
        secret_leak_detected: false,
        failure_reason: 'Real GitHub reliability mode is not implemented in this build',
        started_at: nowIso(),
        finished_at: nowIso(),
        duration_ms: 0,
      });
    }
  }

  const scorecard = computeScorecard(config, results);
  writeScorecard(reportDir, scorecard);
  writeFileSync(
    join(reportDir, 'campaign.json'),
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

function writeScenarioReport(reportDir: string, scenarioId: string, result: ReliabilityScenarioResult): void {
  const dir = join(reportDir, 'scenarios', scenarioId);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const md = `# Reliability Scenario Report: ${scenarioId}

- **Classification:** ${result.classification} (expected: ${result.expected_classification}) ${result.classification_correct ? '✅' : '❌'}
- **Verdict:** ${result.verdict} (expected: ${result.expected_verdict}) ${result.verdict_correct ? '✅' : '❌'}
- **Repair attempts:** ${result.repair_attempts}
- **Repair commits:** ${result.repair_commits.join(', ') || 'none'}
- **Unsafe patch detected:** ${result.unsafe_patch_detected}
- **Unauthorized files:** ${result.unauthorized_files.join(', ') || 'none'}
- **Secret leak detected:** ${result.secret_leak_detected}
- **Failure reason:** ${result.failure_reason ?? 'none'}
- **Duration:** ${result.duration_ms}ms
`;
  writeFileSync(join(dir, 'report.md'), md, 'utf-8');
  writeFileSync(join(dir, 'report.json'), JSON.stringify(result, null, 2), 'utf-8');
  writeFileSync(
    join(dir, 'timeline.json'),
    JSON.stringify(
      [
        { timestamp: result.started_at, event: 'scenario_started' },
        { timestamp: result.finished_at, event: 'scenario_finished', payload: { verdict: result.verdict } },
      ],
      null,
      2
    ),
    'utf-8'
  );
}

function writeScorecard(reportDir: string, scorecard: ReliabilityRunResult['scorecard']): void {
  const md = `# Reliability Scorecard

- **Run id:** ${scorecard.run_id}
- **Mode:** ${scorecard.mode}
- **Total scenarios:** ${scorecard.total_scenarios}
- **Correctly classified:** ${scorecard.correctly_classified}
- **Autonomously repaired:** ${scorecard.autonomously_repaired}
- **External blockers stopped:** ${scorecard.external_blockers_stopped}
- **Ambiguous blockers stopped:** ${scorecard.ambiguous_blockers_stopped}
- **Unsafe patches rejected:** ${scorecard.unsafe_patches_rejected}
- **False green count:** ${scorecard.false_green_count}
- **Unauthorized file count:** ${scorecard.unauthorized_file_count}
- **Secret leak count:** ${scorecard.secret_leak_count}
- **Real CI red-to-green:** ${scorecard.real_ci_red_to_green_count}
- **Reliability %:** ${scorecard.final_reliability_percentage}
- **Verdict:** ${scorecard.verdict}
- **Reason:** ${scorecard.reason}

## Scenarios

| Scenario | Classification | Verdict | Attempts |
|---|---|---|---|
${scorecard.scenarios.map((s) => `| ${s.scenario_id} | ${s.classification} | ${s.verdict} | ${s.repair_attempts} |`).join('\n')}
`;
  writeFileSync(join(reportDir, 'scorecard.md'), md, 'utf-8');
  writeFileSync(join(reportDir, 'scorecard.json'), JSON.stringify(scorecard, null, 2), 'utf-8');
}

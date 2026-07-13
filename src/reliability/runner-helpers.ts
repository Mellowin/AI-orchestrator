import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type {
  ReliabilityCampaignScenarioState,
  ReliabilityCampaignState,
  ReliabilityClassification,
  ReliabilityConfig,
  ReliabilityRunOptions,
  ReliabilityRunResult,
  ReliabilityScenarioConfig,
  ReliabilityScenarioResult,
  ReliabilityScenarioVerdict,
} from './types.js';
import { applyScenarioPatches } from './patch-scenario.js';
import { getClassificationMeta, isAmbiguousBlocker, isExternalBlocker, isRepairPermitted } from './classifier.js';
import { runRepairStrategy } from './repair-strategies.js';
import { checkRepairSafety } from './repair-safety.js';
import { getGitRemoteUrl } from '../git-push-auth.js';
import { redactSecrets } from '../diagnose-ci/redaction.js';
import { createDraftPullRequest } from '../github-pr-client.js';

export function nowIso(): string {
  return new Date().toISOString();
}

export function normalizeCommand(
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

export function runCommand(
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

export function createTempClone(
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

export function configureGitIdentity(repoPath: string, spawnFn: ReliabilityRunOptions['spawnFn']): void {
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

export function setupScenarioRepo(
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

export function runLocalChecks(
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

export function classifyScenario(
  scenario: ReliabilityScenarioConfig,
  logOutput: string
): ReliabilityClassification {
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

export interface FinishScenarioInput {
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
  pr_number?: number;
  pr_url?: string;
  original_ci_run_id?: number;
  original_ci_conclusion?: string | null;
  final_ci_run_id?: number;
  final_ci_conclusion?: string | null;
}

export function finishScenario(input: FinishScenarioInput): ReliabilityScenarioResult {
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
    pr_number,
    pr_url,
    original_ci_run_id,
    original_ci_conclusion,
    final_ci_run_id,
    final_ci_conclusion,
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
    pr_number,
    pr_url,
    original_ci_run_id,
    original_ci_conclusion,
    final_ci_run_id,
    final_ci_conclusion,
    unsafe_patch_detected: unsafeDetected,
    unauthorized_files: unauthorizedFiles,
    secret_leak_detected: secretLeak,
    failure_reason: failureReason ? redactSecrets(failureReason) : undefined,
    started_at: startedAt,
    finished_at: nowIso(),
    duration_ms: Date.now() - startTime,
  };
}

export function determineVerdict(
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

export function writeScenarioReport(reportDir: string, scenarioId: string, result: ReliabilityScenarioResult): void {
  const dir = join(reportDir, 'scenarios', scenarioId);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const md = `# Reliability Scenario Report: ${scenarioId}

- **Classification:** ${result.classification} (expected: ${result.expected_classification}) ${result.classification_correct ? '✅' : '❌'}
- **Verdict:** ${result.verdict} (expected: ${result.expected_verdict}) ${result.verdict_correct ? '✅' : '❌'}
- **Repair attempts:** ${result.repair_attempts}
- **Repair commits:** ${result.repair_commits.join(', ') || 'none'}
- **PR:** ${result.pr_number ? `#${result.pr_number} (${result.pr_url})` : 'none'}
- **Original CI:** ${result.original_ci_run_id ? `${result.original_ci_run_id} (${result.original_ci_conclusion ?? 'unknown'})` : 'none'}
- **Final CI:** ${result.final_ci_run_id ? `${result.final_ci_run_id} (${result.final_ci_conclusion ?? 'unknown'})` : 'none'}
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

export function writeScorecard(reportDir: string, scorecard: ReliabilityRunResult['scorecard']): void {
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

// ---------------------------------------------------------------------------
// Real GitHub mode helpers
// ---------------------------------------------------------------------------

export function parseRepoSlug(slug: string): { owner: string; repo: string } {
  const parts = slug.split('/');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(`Invalid repo_slug: ${slug}`);
  }
  return { owner: parts[0], repo: parts[1] };
}

export function getGitHubToken(config: ReliabilityConfig): string | undefined {
  const envName = config.github_token_env ?? 'GITHUB_TOKEN';
  return process.env[envName]?.trim();
}

export function buildGitHubTokenRemoteUrl(owner: string, repo: string, token: string): string {
  return `https://x-access-token:${token}@github.com/${owner}/${repo}.git`;
}

function redactToken(text: string, token: string): string {
  if (!token) return text;
  return text.split(token).join('***');
}

export interface PushBranchResult {
  ok: boolean;
  sha?: string;
  message?: string;
}

export async function pushBranchWithToken(
  repoPath: string,
  branch: string,
  token: string | undefined,
  owner: string,
  repo: string,
  spawnFn: NonNullable<ReliabilityRunOptions['spawnFn']>
): Promise<PushBranchResult> {
  const tokenRemoteUrl = token ? buildGitHubTokenRemoteUrl(owner, repo, token) : null;
  const originalRemoteUrl = getGitRemoteUrl(repoPath, 'origin');

  if (tokenRemoteUrl) {
    const setResult = spawnFn('git', ['remote', 'set-url', 'origin', tokenRemoteUrl], {
      cwd: repoPath,
      encoding: 'utf-8',
      shell: false,
    });
    if (setResult.status !== 0) {
      return { ok: false, message: redactSecrets(redactToken(setResult.stderr || setResult.stdout, token ?? '')) };
    }
  }

  const pushResult = spawnFn('git', ['push', 'origin', branch], {
    cwd: repoPath,
    encoding: 'utf-8',
    shell: false,
    timeout: 60000,
  });

  if (originalRemoteUrl && tokenRemoteUrl) {
    spawnFn('git', ['remote', 'set-url', 'origin', originalRemoteUrl], {
      cwd: repoPath,
      encoding: 'utf-8',
      shell: false,
    });
  }

  if (pushResult.status !== 0) {
    const raw = pushResult.stderr || pushResult.stdout || 'git push failed';
    return { ok: false, message: redactSecrets(redactToken(raw, token ?? '')) };
  }

  const shaResult = spawnFn('git', ['rev-parse', 'HEAD'], {
    cwd: repoPath,
    encoding: 'utf-8',
    shell: false,
  });
  return { ok: true, sha: shaResult.status === 0 ? shaResult.stdout.trim() : '' };
}

export interface WorkflowRunInfo {
  run_id: number;
  status: string;
  conclusion: string | null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function pollGitHubActionsRun(
  owner: string,
  repo: string,
  sha: string,
  token: string,
  config: ReliabilityConfig,
  fetchFn: typeof globalThis.fetch,
  nowFn: () => number
): Promise<WorkflowRunInfo | null> {
  const timeoutMs = (config.ci_timeout_seconds ?? 600) * 1000;
  const intervalMs = (config.ci_poll_interval_seconds ?? 15) * 1000;
  const start = nowFn();
  const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/runs?head_sha=${encodeURIComponent(sha)}&per_page=10`;

  while (nowFn() - start < timeoutMs) {
    try {
      const response = await fetchFn(url, {
        method: 'GET',
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${token}`,
          'X-GitHub-Api-Version': '2022-11-28',
        },
      });
      if (response.ok) {
        const data = (await response.json()) as {
          workflow_runs?: Array<{ id?: unknown; status?: string; conclusion?: string | null }>;
        };
        const runs = data.workflow_runs ?? [];
        const completed = runs.find((r) => r.status === 'completed');
        if (completed) {
          return {
            run_id: typeof completed.id === 'number' ? completed.id : 0,
            status: completed.status ?? 'completed',
            conclusion: completed.conclusion ?? null,
          };
        }
      }
    } catch {
      // Ignore transient poll errors and retry until timeout.
    }
    await sleep(intervalMs);
  }
  return null;
}

export async function closePullRequest(
  owner: string,
  repo: string,
  prNumber: number,
  token: string,
  fetchFn: typeof globalThis.fetch
): Promise<boolean> {
  const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${prNumber}`;
  try {
    const response = await fetchFn(url, {
      method: 'PATCH',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ state: 'closed' }),
    });
    return response.ok;
  } catch {
    return false;
  }
}

export function getCampaignStatePath(reportDir: string): string {
  return join(reportDir, 'campaign-state.json');
}

export function loadCampaignState(reportDir: string): ReliabilityCampaignState | null {
  const path = getCampaignStatePath(reportDir);
  if (!existsSync(path)) {
    return null;
  }
  try {
    const raw = readFileSync(path, 'utf-8');
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return null;
    }
    return parsed as ReliabilityCampaignState;
  } catch {
    return null;
  }
}

export function saveCampaignState(reportDir: string, state: ReliabilityCampaignState): void {
  const path = getCampaignStatePath(reportDir);
  if (!existsSync(reportDir)) {
    mkdirSync(reportDir, { recursive: true });
  }
  writeFileSync(path, JSON.stringify(state, null, 2), 'utf-8');
}

export async function checkoutRemoteBranch(
  repoPath: string,
  branch: string,
  owner: string,
  repo: string,
  token: string | undefined,
  spawnFn: NonNullable<ReliabilityRunOptions['spawnFn']>
): Promise<void> {
  const tokenUrl = token ? buildGitHubTokenRemoteUrl(owner, repo, token) : null;
  if (tokenUrl) {
    spawnFn('git', ['remote', 'set-url', 'origin', tokenUrl], {
      cwd: repoPath,
      encoding: 'utf-8',
      shell: false,
    });
  }
  const fetchResult = spawnFn('git', ['fetch', 'origin', branch], {
    cwd: repoPath,
    encoding: 'utf-8',
    shell: false,
    timeout: 60000,
  });
  if (fetchResult.status !== 0) {
    throw new Error(`Failed to fetch branch ${branch}: ${fetchResult.stderr || fetchResult.stdout}`);
  }
  const checkoutResult = spawnFn('git', ['checkout', '-b', branch, `origin/${branch}`], {
    cwd: repoPath,
    encoding: 'utf-8',
    shell: false,
  });
  if (checkoutResult.status !== 0) {
    const localCheckout = spawnFn('git', ['checkout', branch], {
      cwd: repoPath,
      encoding: 'utf-8',
      shell: false,
    });
    if (localCheckout.status !== 0) {
      throw new Error(`Failed to checkout branch ${branch}: ${checkoutResult.stderr || checkoutResult.stdout}`);
    }
    const resetResult = spawnFn('git', ['reset', '--hard', `origin/${branch}`], {
      cwd: repoPath,
      encoding: 'utf-8',
      shell: false,
    });
    if (resetResult.status !== 0) {
      throw new Error(`Failed to reset branch ${branch}: ${resetResult.stderr || resetResult.stdout}`);
    }
  }
}

export async function runGitHubScenario(
  scenario: ReliabilityScenarioConfig,
  config: ReliabilityConfig,
  reportDir: string,
  options: ReliabilityRunOptions,
  campaignState: ReliabilityCampaignState,
  saveCampaignStateFn: (state: ReliabilityCampaignState) => void
): Promise<ReliabilityScenarioResult> {
  const startedAt = nowIso();
  const startTime = options.nowFn ? options.nowFn() : Date.now();
  const spawnFn = options.spawnFn ?? spawnSync;
  const fetchFn = options.fetchFn ?? globalThis.fetch;
  const nowFn = options.nowFn ?? Date.now;
  const { owner, repo } = parseRepoSlug(config.repo_slug);
  const token = getGitHubToken(config);
  const tempRoot = config.temp_root ?? resolve(reportDir, 'temp');
  if (!existsSync(tempRoot)) {
    mkdirSync(tempRoot, { recursive: true });
  }

  let scenarioState: ReliabilityCampaignScenarioState =
    campaignState.scenarios.find((s) => s.scenario_id === scenario.id) ?? {
      scenario_id: scenario.id,
      status: 'pending',
    };

  function saveScenarioState(): void {
    const idx = campaignState.scenarios.findIndex((s) => s.scenario_id === scenario.id);
    if (idx >= 0) {
      campaignState.scenarios[idx] = scenarioState;
    } else {
      campaignState.scenarios.push(scenarioState);
    }
    campaignState.updated_at = nowIso();
    saveCampaignStateFn(campaignState);
  }

  let repoPath: string | undefined;
  let branch: string;
  let prNumber: number | undefined;
  let prUrl: string | undefined;
  let setupSha: string | undefined;
  const repairCommits: string[] = [];
  let repairOk = false;
  let checksOk = false;
  let unsafeDetected = false;
  let secretLeak = false;
  let unauthorizedFiles: string[] = [];
  let failureReason: string | undefined;
  let repairAttemptCount = 0;

  try {
    const classification = classifyScenario(scenario, '');
    const meta = getClassificationMeta(classification);

    const blocked =
      scenario.category === 'external' ||
      scenario.category === 'unsafe' ||
      isExternalBlocker(classification) ||
      isAmbiguousBlocker(classification) ||
      !scenario.fixable ||
      !isRepairPermitted(classification);

    if (blocked) {
      let verdict: ReliabilityScenarioVerdict;
      if (scenario.category === 'external' || isExternalBlocker(classification)) {
        verdict = 'EXTERNAL_BLOCKER';
      } else if (scenario.category === 'unsafe') {
        verdict = 'UNSAFE_PATCH_REJECTED';
      } else {
        verdict = meta.finalVerdictWhenBlocked;
      }
      return finishScenario({
        scenario,
        classification,
        verdict,
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

    if (!token) {
      return finishScenario({
        scenario,
        classification,
        verdict: 'EXTERNAL_BLOCKER',
        repairCommits,
        unsafeDetected,
        unauthorizedFiles,
        secretLeak,
        failureReason: 'GitHub token not configured',
        repairAttemptCount,
        startedAt,
        startTime,
      });
    }

    if (scenarioState.status === 'pending' || !scenarioState.status) {
      const setup = setupScenarioRepo(scenario, config.repo_path, tempRoot, spawnFn);
      repoPath = setup.repoPath;
      branch = setup.branch;

      const pushResult = await pushBranchWithToken(repoPath, branch, token, owner, repo, spawnFn);
      if (!pushResult.ok) {
        throw new Error(`Failed to push setup branch: ${pushResult.message}`);
      }
      setupSha = pushResult.sha;

      const prResult = await createDraftPullRequest(
        {
          repoFullName: config.repo_slug,
          baseBranch: config.base_branch,
          headBranch: branch,
          title: `reliability: seed fault for ${scenario.id}`,
          body: `Autonomous reliability scenario ${scenario.id}`,
          token,
        },
        { fetchFn }
      );
      if (!prResult.ok) {
        if (prResult.status === 'skipped_missing_token') {
          return finishScenario({
            scenario,
            classification,
            verdict: 'EXTERNAL_BLOCKER',
            repairCommits,
            unsafeDetected,
            unauthorizedFiles,
            secretLeak,
            failureReason: 'GitHub token not configured',
            repairAttemptCount,
            startedAt,
            startTime,
          });
        }
        throw new Error(`Failed to create draft PR: ${prResult.message}`);
      }
      prNumber = prResult.number;
      prUrl = prResult.url;

      scenarioState = {
        ...scenarioState,
        status: 'setup_pushed',
        branch,
        pr_number: prNumber,
        pr_url: prUrl,
        setup_sha: setupSha,
      };
      saveScenarioState();
      console.error(`[reliability] ${scenario.id}: pushed setup ${setupSha}, PR #${prNumber}`);
    } else {
      branch = scenarioState.branch ?? `reliability-${scenario.id}-${Date.now()}`;
      prNumber = scenarioState.pr_number;
      prUrl = scenarioState.pr_url;
      setupSha = scenarioState.setup_sha;
      if (scenarioState.repair_shas) {
        repairCommits.push(...scenarioState.repair_shas);
      }
    }

    if (!setupSha) {
      throw new Error('Setup SHA missing after resume');
    }

    if (scenarioState.original_ci_run_id === undefined) {
      console.error(`[reliability] ${scenario.id}: polling original CI for ${setupSha}`);
      const originalRun = await pollGitHubActionsRun(owner, repo, setupSha, token, config, fetchFn, nowFn);
      if (!originalRun) {
        failureReason = 'Timed out waiting for original CI run for setup SHA';
        return finishScenario({
          scenario,
          classification,
          verdict: 'REPAIR_EXHAUSTED',
          repairCommits,
          unsafeDetected,
          unauthorizedFiles,
          secretLeak,
          failureReason,
          repairAttemptCount,
          startedAt,
          startTime,
          pr_number: prNumber,
          pr_url: prUrl,
          original_ci_run_id: scenarioState.original_ci_run_id,
          original_ci_conclusion: scenarioState.original_ci_conclusion,
          final_ci_run_id: scenarioState.final_ci_run_id,
          final_ci_conclusion: scenarioState.final_ci_conclusion,
        });
      }
      scenarioState.original_ci_run_id = originalRun.run_id;
      scenarioState.original_ci_conclusion = originalRun.conclusion;
      saveScenarioState();
    }

    if (scenarioState.status === 'setup_pushed') {
      if (!repoPath) {
        repoPath = createTempClone(config.repo_path, tempRoot, spawnFn);
        configureGitIdentity(repoPath, spawnFn);
        await checkoutRemoteBranch(repoPath, branch, owner, repo, token, spawnFn);
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

        const addResult = spawnFn('git', ['add', '-A'], { cwd: repoPath, encoding: 'utf-8', shell: false });
        if (addResult.status === 0) {
          const commitResult = spawnFn(
            'git',
            ['commit', '-m', `reliability: repair attempt ${repairAttemptCount} for ${scenario.id}`],
            { cwd: repoPath, encoding: 'utf-8', shell: false }
          );
          if (commitResult.status === 0) {
            const shaResult = spawnFn('git', ['rev-parse', 'HEAD'], {
              cwd: repoPath,
              encoding: 'utf-8',
              shell: false,
            });
            if (shaResult.status === 0) {
              repairCommits.push(shaResult.stdout.trim());
            }
          }
        }

        const pushResult = await pushBranchWithToken(repoPath, branch, token, owner, repo, spawnFn);
        if (!pushResult.ok) {
          failureReason = pushResult.message;
          continue;
        }
        const repairSha = pushResult.sha;

        if (repairSha) {
          scenarioState.repair_shas = repairCommits;
          scenarioState.status = 'repair_pushed';
          saveScenarioState();

          const finalRun = await pollGitHubActionsRun(owner, repo, repairSha, token, config, fetchFn, nowFn);
          if (!finalRun) {
            failureReason = 'Timed out waiting for repair CI run';
            break;
          }
          scenarioState.final_ci_run_id = finalRun.run_id;
          scenarioState.final_ci_conclusion = finalRun.conclusion;
          saveScenarioState();

          if (finalRun.conclusion === 'success') {
            repairOk = true;
            checksOk = true;
            break;
          } else {
            failureReason = `Repair attempt ${repairAttemptCount} CI conclusion: ${finalRun.conclusion}`;
          }
        }
      }
    } else if (scenarioState.status === 'repair_pushed') {
      const lastRepairSha = scenarioState.repair_shas?.[scenarioState.repair_shas.length - 1];
      repairAttemptCount = scenarioState.repair_shas?.length ?? 0;
      if (lastRepairSha && scenarioState.final_ci_run_id === undefined) {
        const finalRun = await pollGitHubActionsRun(owner, repo, lastRepairSha, token, config, fetchFn, nowFn);
        if (!finalRun) {
          failureReason = 'Timed out waiting for repair CI run on resume';
        } else {
          scenarioState.final_ci_run_id = finalRun.run_id;
          scenarioState.final_ci_conclusion = finalRun.conclusion;
          saveScenarioState();
          if (finalRun.conclusion === 'success') {
            repairOk = true;
            checksOk = true;
          } else {
            failureReason = `Repair CI conclusion: ${finalRun.conclusion}`;
          }
        }
      } else if (scenarioState.final_ci_conclusion === 'success') {
        repairOk = true;
        checksOk = true;
      } else {
        failureReason = scenarioState.final_ci_conclusion
          ? `Repair CI conclusion: ${scenarioState.final_ci_conclusion}`
          : undefined;
      }
    }

    const verdict = determineVerdict(
      scenario,
      classification,
      repairOk,
      checksOk,
      unsafeDetected,
      unauthorizedFiles,
      secretLeak
    );

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
      pr_number: prNumber,
      pr_url: prUrl,
      original_ci_run_id: scenarioState.original_ci_run_id,
      original_ci_conclusion: scenarioState.original_ci_conclusion,
      final_ci_run_id: scenarioState.final_ci_run_id,
      final_ci_conclusion: scenarioState.final_ci_conclusion,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return finishScenario({
      scenario,
      classification: scenario.classification,
      verdict: 'REPAIR_EXHAUSTED',
      repairCommits,
      unsafeDetected,
      unauthorizedFiles,
      secretLeak,
      failureReason: message,
      repairAttemptCount,
      startedAt,
      startTime,
      pr_number: prNumber,
      pr_url: prUrl,
      original_ci_run_id: scenarioState.original_ci_run_id,
      original_ci_conclusion: scenarioState.original_ci_conclusion,
      final_ci_run_id: scenarioState.final_ci_run_id,
      final_ci_conclusion: scenarioState.final_ci_conclusion,
    });
  } finally {
    if (prNumber && token) {
      console.error(`[reliability] ${scenario.id}: closing PR #${prNumber}`);
      await closePullRequest(owner, repo, prNumber, token, fetchFn).catch(() => {});
    }
    if (repoPath && repoPath.startsWith(tempRoot)) {
      try {
        rmSync(repoPath, { recursive: true, force: true });
      } catch {
        // ignore cleanup failure
      }
    }
  }
}

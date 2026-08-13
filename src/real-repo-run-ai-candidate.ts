import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import type { FetchFn } from './provider-call.js';
import { createRealProviderCall, createMockProviderCall } from './provider-call.js';
import { runCoderProviderPipeline } from './coder-provider-pipeline.js';
import { buildContext } from './context-builder.js';
import { buildKimiPrompt } from './prompt-builder.js';
import {
  validateFileList,
} from './guardrails.js';
import { validateAiSafetyPolicy } from './ai-safety-policy.js';
import { applyFileUpdates, rollbackFileUpdates } from './patch-engine.js';
import { runChecks } from './runner.js';
import { runRealRepoSandboxPreflight } from './real-repo-sandbox-preflight.js';
import { buildRealRepoApplyPlan } from './real-repo-apply-plan.js';
import {
  writeProviderAttemptEvidence,
  buildNoEffectRecoveryPrompt,
} from './provider-attempt-evidence.js';
import { runReviewerGateWithProvider } from './reviewer-provider-runner.js';
import { buildCandidateReviewerEvidence } from './reviewer-evidence.js';
import { buildReviewInput } from './reviewer/review-input-builder.js';
import { createKimiReviewerProvider } from './providers/kimi/kimi-reviewer-provider.js';
import { getGitRemoteUrl } from './git-push-auth.js';
import { buildFixTaskPrompt } from './reviewer-fix-task-real-executor.js';
import { loadState, saveState, initState, getRunDir } from './state-manager.js';
import { redactSecrets } from './sandbox-preflight-repair.js';
import type {
  KimiOutput,
  ProviderAttempt,
  ProviderAttemptType,
  RunState,
  Task,
  TaskRunPhase,
} from './types.js';
import type { PersistedReviewerGate } from './reviewer-task-outcome.js';
import type { ReviewerEvidence } from './reviewer-evidence.js';
import {
  createCandidateWorkspace,
  validateCandidateWorkspace,
  stageCandidateFiles,
  getCandidateDiff,
  getCandidateHead,
  getCommitParent,
  getRemoteBranchHead,
  cleanupCandidateWorkspace,
  configureCandidateRemote,
  pushCandidateCommit,
  fastForwardMissionBranch,
  reconcileCandidateWorkspace,
  verifyCommitAgainstSnapshot,
  type CandidateReconcileResult,
} from './candidate-workspace.js';
import {
  saveCandidateSnapshot,
  loadLatestCandidateSnapshot,
  restoreCandidateSnapshot,
  computeFileHash,
  type CandidateSnapshot,
} from './candidate-state.js';
import {
  buildCandidateReviewPackage,
  saveCandidateReviewPackage,
  type CandidateReviewPackage,
} from './candidate-review-package.js';

export interface RealRepoRunAICandidateFlowInput {
  task: Task;
  taskBaseSha: string;
  candidatePath: string;
  runId: string;
  attempt?: number;
  isResume: boolean;
  resumeTimeoutMs?: number;
  maxAttempts: number;
  reviewerMaxFixAttempts: number;
  reviewerParseRetries: number;
  apiKey: string;
  baseUrl: string;
  model: string;
  userAgent?: string;
  fetchFn: FetchFn;
  runsDir: string;
  logPrefix?: string;
}

export interface RealRepoRunAICandidateFlowResult {
  exitCode: number;
  state: RunState;
}

const VALID_SHA = /^[0-9a-f]{40}$/i;

function nowIso(): string {
  return new Date().toISOString();
}

function log(prefix: string, message: string): void {
  console.error(`${prefix} ${message}`);
}

function parseFakeResponseArray(raw: string | undefined): string[] {
  if (raw === undefined) {
    return [];
  }
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed.map((item) => (item === null ? '' : String(item)));
    }
  } catch {
    // fall through
  }
  return [raw];
}

function makeMockFetchFn(response: string): FetchFn {
  return async () => ({
    ok: true,
    status: 200,
    json: async () => ({ choices: [{ message: { content: response } }] }),
  });
}

function git(args: string[], cwd: string, allowFailure = false): { status: number; stdout: string; stderr: string } {
  const result = spawnSync('git', args, {
    cwd,
    shell: false,
    encoding: 'utf-8',
  });
  if (!allowFailure && result.status !== 0) {
    throw new Error(result.stderr?.trim() || `git ${args.join(' ')} failed`);
  }
  return {
    status: result.status ?? 1,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  };
}

function getRepoWorkingTreeChanges(repoPath: string): {
  modified: string[];
  staged: string[];
  untracked: string[];
  all: string[];
} {
  const result = spawnSync('git', ['status', '--porcelain', '--untracked-files=all'], {
    cwd: repoPath,
    shell: false,
    encoding: 'utf-8',
  });
  if (result.error) {
    throw new Error(`Git status failed: ${result.error.message}`);
  }

  const modified: string[] = [];
  const staged: string[] = [];
  const untracked: string[] = [];

  const lines = (result.stdout || '').split('\n').map((s) => s.trimEnd()).filter((s) => s.length > 0);
  for (const line of lines) {
    const statusCode = line.slice(0, 2);
    const pathPart = line.slice(3);
    const filePath = pathPart.includes(' -> ') ? pathPart.split(' -> ')[1] : pathPart;

    if (statusCode === '??') {
      untracked.push(filePath);
    } else {
      if (statusCode[0] !== ' ' && statusCode[0] !== '?') {
        staged.push(filePath);
      }
      if (statusCode[1] !== ' ' && statusCode[1] !== '?') {
        modified.push(filePath);
      }
    }
  }

  return {
    modified,
    staged,
    untracked,
    all: [...new Set([...modified, ...staged, ...untracked])],
  };
}

function buildCheckSummary(
  checks: Task['checks'],
  success: boolean
): ReviewerEvidence['checkSummary'] {
  const hasTypecheck = checks.some((c) => classifyCheckCommand(c.command, c.args) === 'typecheck');
  const hasBuild = checks.some((c) => classifyCheckCommand(c.command, c.args) === 'build');
  const hasTest = checks.some((c) => classifyCheckCommand(c.command, c.args) === 'test');
  return {
    test: hasTest ? (success ? 'pass' : 'fail') : 'not_run',
    typecheck: hasTypecheck ? (success ? 'pass' : 'fail') : 'not_run',
    build: hasBuild ? (success ? 'pass' : 'fail') : 'not_run',
  };
}

function classifyCheckCommand(command: string, args: string[]): 'typecheck' | 'build' | 'test' | 'other' {
  const full = `${command} ${args.join(' ')}`.toLowerCase();
  if (full.includes('typecheck') || full.includes('tsc')) return 'typecheck';
  if (full.includes('build')) return 'build';
  if (full.includes('test')) return 'test';
  return 'other';
}

function buildCheckRepairPrompt(
  task: Task,
  branch: string,
  checkResult: { success: boolean; logs: string; failedStep?: { command: string; args: string[] } },
  previousFiles: Array<{ path: string; content: string }>
): string {
  const failedCommand = checkResult.failedStep
    ? `${checkResult.failedStep.command} ${checkResult.failedStep.args.join(' ')}`
    : 'unknown';
  const previousPaths = previousFiles.map((f) => f.path).join(', ');
  const maxLines = task.guardrails.max_lines_changed;

  const lines: string[] = [
    '# Task (Repair Attempt)',
    '',
    `Task ID: ${task.id}`,
    `Branch: ${branch}`,
    `Title: ${task.title}`,
    `Goal: ${task.goal}`,
    '',
    '# Previous Attempt Failed',
    '',
    `Failed check command: ${failedCommand}`,
    '',
    'Check output summary:',
    checkResult.logs,
    '',
    `Previously proposed files: ${previousPaths}`,
  ];

  if (maxLines !== undefined) {
    lines.push(
      '',
      '# Line change budget',
      `Advisory budget: prefer to keep any single file change under ${maxLines} lines. ` +
        'Do not compromise correctness or safety to fit the budget; if the required fix needs more lines, include a note explaining why.'
    );
  }

  lines.push(
    '',
    'Fix the failing check. Return ONLY valid JSON using the file_update schema.',
    'Return full file content, not diffs.',
    'Do not modify files outside the allowed scope.',
    'Do not include markdown outside JSON.'
  );

  return lines.join('\n');
}

function buildGuardrailsRecoveryPrompt(
  task: Task,
  guardrailsReason: string,
  previousFiles: Array<{ path: string; content: string }>
): string {
  const allowedFiles = task.guardrails.allow_modify?.join(', ') ?? 'none';
  const previousPaths = previousFiles.map((f) => f.path).join(', ');
  const maxLines = task.guardrails.max_lines_changed;

  const lines: string[] = [
    '# Task (Guardrails Recovery Attempt)',
    '',
    `Task ID: ${task.id}`,
    `Title: ${task.title}`,
    `Goal: ${task.goal}`,
    '',
    '# Guardrails Rejection',
    '',
    `Reason: ${guardrailsReason}`,
    '',
    `Previously proposed files: ${previousPaths}`,
    '',
    '# Allowed Files',
    '',
    `You are ONLY allowed to create or modify these files: ${allowedFiles}`,
  ];

  if (maxLines !== undefined) {
    const previousPreview = previousFiles
      .map((f) => `  ${f.path}: ${f.content.split('\n').length} lines`)
      .join('\n');
    lines.push(
      '',
      '# Line Change Budget',
      `Advisory budget: prefer to keep any single file change under ${maxLines} lines.`,
      'Previously proposed file sizes:',
      previousPreview,
      'Do not compromise correctness or safety to fit the budget; if the required change needs more lines, include a note explaining why.'
    );
  }

  lines.push(
    '',
    'Return ONLY valid JSON using the file_update schema.',
    'Return full file content, not diffs.',
    'Do not modify files outside the allowed scope.',
    'Do not include markdown outside JSON.'
  );

  return lines.join('\n');
}

function makeCandidateTask(task: Task, candidatePath: string): Task {
  return {
    ...task,
    repo_path: candidatePath,
  };
}

function buildSnapshot(
  attemptId: string,
  phase: string,
  taskBaseSha: string,
  changedFiles: string[],
  candidatePath: string
): CandidateSnapshot {
  const fileContents = changedFiles.map((path) => {
    const content = readFileSync(resolve(candidatePath, path), 'utf-8');
    return { path, content, sha256: computeFileHash(content) };
  });
  return {
    attemptId,
    phase,
    taskBaseSha,
    changedFiles,
    fileContents,
    candidatePackageHash: '', // filled by saveCandidateSnapshot
  };
}

function saveWorkspaceSnapshot(
  runsDir: string,
  taskId: string,
  phase: string,
  taskBaseSha: string,
  changedFiles: string[],
  candidatePath: string
): void {
  const attemptId = `${phase}-${Date.now()}-${createHash('sha256').update(changedFiles.join(',')).digest('hex').slice(0, 8)}`;
  const snapshot = buildSnapshot(attemptId, phase, taskBaseSha, changedFiles, candidatePath);
  saveCandidateSnapshot(runsDir, taskId, snapshot);
}

export async function runRealRepoRunAICandidateFlow(
  input: RealRepoRunAICandidateFlowInput
): Promise<RealRepoRunAICandidateFlowResult> {
  const {
    task,
    taskBaseSha,
    candidatePath,
    runId,
    isResume,
    resumeTimeoutMs,
    maxAttempts,
    reviewerMaxFixAttempts,
    reviewerParseRetries,
    apiKey,
    baseUrl,
    model,
    userAgent,
    fetchFn,
    runsDir,
    logPrefix = '[real-repo-run-ai]',
  } = input;

  const prefix = logPrefix;
  let fixAttempted = false;

  // Fake response arrays for deterministic integration tests. The parent passes
  // per-task arrays via env vars; each round of the reviewer/fix loop consumes
  // one element.
  const fixKimiFakeResponses = parseFakeResponseArray(
    process.env.REAL_REPO_REVIEWER_FIX_TASK_KIMI_FAKE_RESPONSES ?? process.env.REAL_REPO_REVIEWER_FIX_TASK_KIMI_FAKE_RESPONSE
  );
  const secondReviewerFakeResponses = parseFakeResponseArray(
    process.env.REAL_REPO_REVIEWER_SECOND_FAKE_RESPONSES ?? process.env.REAL_REPO_REVIEWER_SECOND_FAKE_RESPONSE
  );

  if (!VALID_SHA.test(taskBaseSha)) {
    log(prefix, `Invalid task_base_sha: ${taskBaseSha}`);
    return {
      exitCode: 1,
      state: {
        ...initState(task),
        status: 'failed',
        task_phase: 'failed',
        task_base_sha: taskBaseSha,
        candidate_path: candidatePath,
        safety_note: `Invalid task_base_sha: ${taskBaseSha}`,
        updated_at: nowIso(),
      } as RunState,
    };
  }

  // Load or initialize state.
  let state: RunState;
  const passStartMs = Date.now();
  if (isResume) {
    const loaded = loadState(task.id, runsDir);
    if (!loaded) {
      log(prefix, 'Resume mode: no existing state found');
      return {
        exitCode: 1,
        state: {
          ...initState(task),
          status: 'failed',
          task_phase: 'failed',
          task_base_sha: taskBaseSha,
          candidate_path: candidatePath,
          safety_note: 'Resume mode: no existing state found',
          updated_at: nowIso(),
        } as RunState,
      };
    }
    state = loaded;
    state.child_pid = process.pid;
    state.updated_at = nowIso();
    if (resumeTimeoutMs !== undefined) {
      state.timeout_ms = resumeTimeoutMs;
    }
  } else {
    state = initState(task);
    state.task_base_sha = taskBaseSha;
    state.candidate_path = candidatePath;
    state.task_started_at = state.created_at;
    state.total_elapsed_ms = 0;
    state.continuation_count = 0;
    state.child_pid = process.pid;
    if (process.env.REAL_REPO_TASK_TIMEOUT_MS) {
      state.timeout_ms = Number(process.env.REAL_REPO_TASK_TIMEOUT_MS);
    }
  }
  const previousTotalElapsedMs = state.total_elapsed_ms ?? 0;

  function updateElapsedMs(): void {
    const elapsedThisPass = Date.now() - passStartMs;
    state.total_elapsed_ms = previousTotalElapsedMs + elapsedThisPass;
  }

  function setPhase(phase: TaskRunPhase, extra?: Partial<RunState>): void {
    state.task_phase = phase;
    state.phase_started_at = nowIso();
    state.updated_at = nowIso();
    updateElapsedMs();
    if (extra) {
      Object.assign(state, extra);
    }
    try {
      saveState(task.id, state, runsDir);
    } catch (err) {
      log(prefix, `Failed to save state at phase ${phase}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const terminalPhases: TaskRunPhase[] = ['blocked', 'failed', 'pushed'];
  if (state.task_phase !== undefined && terminalPhases.includes(state.task_phase)) {
    log(prefix, `Resume mode: task already in terminal phase ${state.task_phase}`);
    return { exitCode: state.task_phase === 'pushed' ? 0 : 1, state };
  }

  const candidateTask = makeCandidateTask(task, candidatePath);

  // Create or validate the candidate workspace before reading context files.
  const workspaceResult = createCandidateWorkspace(
    candidatePath,
    task.repo_path,
    taskBaseSha,
    task.work_branch,
    task.id
  );
  if (!workspaceResult.ok) {
    log(prefix, `Candidate workspace creation failed: ${workspaceResult.reason}`);
    setPhase('failed', {
      status: 'failed',
      safety_note: `Candidate workspace creation failed: ${workspaceResult.reason}`,
    });
    return { exitCode: 1, state };
  }

  const context = buildContext(candidateTask);
  const basePrompt = buildKimiPrompt(context);

  // Resume workspace recovery: if invalid, try snapshot restore; otherwise recreate.
  let workspaceValid = validateCandidateWorkspace(
    candidatePath,
    taskBaseSha,
    state.expected_changed_files,
    state.accepted_commit_sha
  ).ok;

  if (isResume && !workspaceValid) {
    const snapshot = loadLatestCandidateSnapshot(runsDir, task.id);
    if (snapshot) {
      log(prefix, 'Restoring candidate workspace from snapshot');
      // Recreate workspace if it is missing or corrupted.
      if (existsSync(candidatePath)) {
        rmSync(candidatePath, { recursive: true, force: true });
      }
      const recreate = createCandidateWorkspace(
        candidatePath,
        task.repo_path,
        taskBaseSha,
        task.work_branch,
        task.id
      );
      if (!recreate.ok) {
        log(prefix, `Failed to recreate workspace for restore: ${recreate.reason}`);
        setPhase('failed', { status: 'failed', safety_note: `Workspace restore failed: ${recreate.reason}` });
        return { exitCode: 1, state };
      }
      const restore = restoreCandidateSnapshot(candidatePath, snapshot);
      if (!restore.ok) {
        log(prefix, `Snapshot restore failed: ${restore.reason}`);
        setPhase('failed', { status: 'failed', safety_note: `Snapshot restore failed: ${restore.reason}` });
        return { exitCode: 1, state };
      }
      const stage = stageCandidateFiles(candidatePath, snapshot.changedFiles);
      if (!stage.ok) {
        log(prefix, `Staging restored files failed: ${stage.reason}`);
        setPhase('failed', { status: 'failed', safety_note: `Staging restored files failed: ${stage.reason}` });
        return { exitCode: 1, state };
      }
      workspaceValid = validateCandidateWorkspace(
        candidatePath,
        taskBaseSha,
        snapshot.changedFiles
      ).ok;
      if (!workspaceValid) {
        log(prefix, 'Candidate workspace still invalid after snapshot restore');
        setPhase('failed', { status: 'failed', safety_note: 'Candidate workspace invalid after snapshot restore' });
        return { exitCode: 1, state };
      }
      state.expected_changed_files = snapshot.changedFiles;
    } else {
      log(prefix, 'No candidate snapshot available; recreating workspace from base');
      if (existsSync(candidatePath)) {
        rmSync(candidatePath, { recursive: true, force: true });
      }
      const recreate = createCandidateWorkspace(
        candidatePath,
        task.repo_path,
        taskBaseSha,
        task.work_branch,
        task.id
      );
      if (!recreate.ok) {
        log(prefix, `Workspace recreation failed: ${recreate.reason}`);
        setPhase('failed', { status: 'failed', safety_note: `Workspace recreation failed: ${recreate.reason}` });
        return { exitCode: 1, state };
      }
      state.expected_changed_files = [];
    }
  }

  let allProviderAttempts: ProviderAttempt[] = state.provider_attempts ?? [];
  let nextProviderAttemptNumber = 1;
  if (allProviderAttempts.length > 0) {
    nextProviderAttemptNumber = Math.max(...allProviderAttempts.map((a) => a.attempt)) + 1;
  }

  let finalKimiOutput: KimiOutput | undefined;
  let finalChangedFiles: string[] = [];
  let lastCheckResult: { success: boolean; logs: string; failedStep?: { command: string; args: string[] } } | undefined;

  const skipToCoder = !isResume || state.task_phase === undefined || state.task_phase === 'generating' || state.task_phase === 'repairing';
  const skipToReview = isResume && (state.task_phase === 'reviewer_pending' || state.task_phase === 'reviewer_fix_pending' || state.task_phase === 'second_review_pending');
  const skipToAcceptance = isResume && (state.task_phase === 'accepted' || state.task_phase === 'committed' || state.task_phase === 'pushed');

  // Coder / repair loop.
  if (!skipToReview && !skipToAcceptance) {
    let repairPrompt: string | undefined;
    let lastKimiOutput: KimiOutput | undefined;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      state.current_attempt = attempt;
      const isRepair = attempt > 1 || repairPrompt !== undefined;
      const currentPrompt = repairPrompt ?? (isRepair && lastCheckResult && lastKimiOutput
        ? buildCheckRepairPrompt(task, task.work_branch, lastCheckResult, lastKimiOutput.files)
        : basePrompt);

      if (isRepair && repairPrompt) {
        log(prefix, `Repair attempt ${attempt}/${maxAttempts} (sandbox preflight)`);
      } else if (isRepair) {
        log(prefix, `Repair attempt ${attempt}/${maxAttempts}`);
      }

      setPhase('generating');
      const providerAttemptType: ProviderAttemptType = isRepair ? 'sandbox_repair' : 'initial_coder';
      const realProviderCall = createRealProviderCall({
        provider: 'kimi',
        apiKey,
        baseUrl,
        fetchFn,
        model,
        userAgent,
      });

      const pipelineResult = await runCoderProviderPipeline({
        taskId: task.id,
        repoPath: candidatePath,
        basePrompt: currentPrompt,
        providerCall: realProviderCall,
        provider: 'kimi',
        model,
        providerAttemptType,
        startingGlobalAttemptNumber: nextProviderAttemptNumber,
        logPrefix: prefix,
      });

      allProviderAttempts.push(...pipelineResult.providerAttempts);
      nextProviderAttemptNumber = pipelineResult.nextGlobalAttemptNumber;
      state.provider_attempts = allProviderAttempts;

      if (!pipelineResult.success) {
        log(prefix, `Provider pipeline failed: ${pipelineResult.reason}`);
        setPhase('failed', {
          status: 'failed',
          safety_note: `Provider failed after retry: ${pipelineResult.reason}`,
        });
        return { exitCode: 1, state };
      }

      const { kimiOutput, rawProviderText, classified, effectiveAttemptDir } = pipelineResult;
      lastKimiOutput = kimiOutput;
      finalKimiOutput = kimiOutput;

      const effectiveProviderAttempt = allProviderAttempts[allProviderAttempts.length - 1];
      if (effectiveProviderAttempt) {
        effectiveProviderAttempt.classification = 'EFFECTIVE_CHANGES';
      }
      state.provider_attempts = allProviderAttempts;

      setPhase('checking');
      const updatePaths = kimiOutput.files.map((f) => f.path);

      const guardrailsResult = validateFileList(updatePaths, candidateTask.guardrails);
      if (!guardrailsResult.ok) {
        log(prefix, `Guardrails failed: ${guardrailsResult.reason}`);
        if (attempt < maxAttempts) {
          repairPrompt = buildGuardrailsRecoveryPrompt(task, guardrailsResult.reason ?? 'unknown', kimiOutput.files);
          continue;
        }
        setPhase('failed', {
          status: 'failed',
          safety_note: `Guardrails failed: ${guardrailsResult.reason}`,
          safety_policy_reasons: [guardrailsResult.reason ?? 'unknown guardrails violation'],
        });
        return { exitCode: 1, state };
      }

      const safetyPolicyResult = validateAiSafetyPolicy({
        repoPath: candidatePath,
        allowedFiles: candidateTask.guardrails.allow_modify,
        deniedFiles: candidateTask.guardrails.deny_modify,
        files: kimiOutput.files,
      });
      if (!safetyPolicyResult.ok) {
        const policyMessage = safetyPolicyResult.reasons.join('; ');
        log(prefix, `Safety policy violation: ${policyMessage}`);
        setPhase('blocked', {
          status: 'blocked',
          blocked_by: 'safety_policy',
          applied: false,
          committed: false,
          pushed: false,
          safety_policy_reasons: safetyPolicyResult.reasons,
          safety_note: 'Blocked by deterministic safety policy before apply',
        });
        return { exitCode: 1, state };
      }

      const sandboxRoot = mkdtempSync(join(tmpdir(), 'preflight-'));
      try {
        const preflightResult = runRealRepoSandboxPreflight({
          task: candidateTask,
          rawProviderText,
          sandboxRoot,
        });
        if (!preflightResult.ok) {
          log(prefix, `Sandbox preflight failed at step: ${preflightResult.failedStep ?? 'unknown'}`);
          if (attempt < maxAttempts) {
            repairPrompt = buildCheckRepairPrompt(
              task,
              task.work_branch,
              { success: false, logs: preflightResult.logs, failedStep: { command: 'sandbox', args: [] } },
              kimiOutput.files
            );
            continue;
          }
          setPhase('failed', {
            status: 'failed',
            safety_note: `Sandbox preflight failed: ${preflightResult.failedStep ?? 'unknown'}`,
          });
          return { exitCode: 1, state };
        }
      } finally {
        if (existsSync(sandboxRoot)) {
          rmSync(sandboxRoot, { recursive: true, force: true });
        }
      }
      repairPrompt = undefined;

      const existingPaths: string[] = [];
      for (const f of kimiOutput.files) {
        if (existsSync(resolve(candidatePath, f.path))) {
          existingPaths.push(f.path);
        }
      }
      const planResult = buildRealRepoApplyPlan({
        taskId: task.id,
        attempt,
        existingPaths,
        files: kimiOutput.files,
      });
      if (!planResult.ok) {
        log(prefix, `Apply plan failed: ${planResult.reason}`);
        setPhase('failed', {
          status: 'failed',
          safety_note: `Apply plan failed: ${planResult.reason}`,
          safety_policy_reasons: planResult.safetyMessages,
        });
        return { exitCode: 1, state };
      }

      let manifest: import('./types.js').PatchManifestEntry[] | undefined;
      try {
        manifest = applyFileUpdates(candidatePath, kimiOutput.files, planResult.runDir);
      } catch (applyErr) {
        const applyMessage = applyErr instanceof Error ? applyErr.message : String(applyErr);
        log(prefix, `Apply failed: ${applyMessage}`);
        setPhase('failed', {
          status: 'failed',
          safety_note: `Apply failed: ${applyMessage}`,
        });
        return { exitCode: 1, state };
      }

      writeProviderAttemptEvidence({
        taskId: task.id,
        attempt,
        repoPath: candidatePath,
        rawText: rawProviderText,
        kimiOutput,
        classified,
        phase: 'post-apply',
        manifest,
        attemptDir: effectiveAttemptDir,
      });

      const postApplyChanges = getRepoWorkingTreeChanges(candidatePath);
      if (postApplyChanges.all.length === 0) {
        if (manifest && manifest.length > 0) {
          try {
            rollbackFileUpdates(candidatePath, manifest);
          } catch {
            // ignore rollback errors; we are already retrying or failing
          }
        }
        if (classified.classification === 'ALL_IDENTICAL' && attempt < maxAttempts) {
          log(prefix, `No effective changes: all proposed files are identical to existing content; retrying`);
          repairPrompt = buildNoEffectRecoveryPrompt(task, classified.classification, classified.files);
          continue;
        }
        if (classified.classification === 'EMPTY_FILE_LIST') {
          log(prefix, 'No file changes proposed; proceeding with empty candidate');
        } else {
          log(prefix, 'APPLY_ENGINE_FAILURE: effective changes predicted but no working tree delta');
          setPhase('failed', {
            status: 'failed',
            safety_note: 'APPLY_ENGINE_FAILURE: effective changes predicted but no git delta after apply',
          });
          return { exitCode: 1, state };
        }
      }

      const approvedPaths = new Set(updatePaths);
      const unrelated = postApplyChanges.all.filter((p) => !approvedPaths.has(p));
      if (unrelated.length > 0) {
        log(prefix, `Unauthorized candidate modification: ${unrelated.join(', ')}`);
        if (manifest && manifest.length > 0) {
          try {
            rollbackFileUpdates(candidatePath, manifest);
          } catch {
            // ignore
          }
        }
        setPhase('blocked', {
          status: 'blocked',
          safety_note: `Unauthorized candidate modification: ${unrelated.join(', ')}`,
          safety_policy_reasons: [`Unauthorized candidate modification: ${unrelated.join(', ')}`],
        });
        return { exitCode: 1, state };
      }

      const stageResult = stageCandidateFiles(candidatePath, updatePaths);
      if (!stageResult.ok) {
        log(prefix, `Staging failed: ${stageResult.reason}`);
        setPhase('failed', {
          status: 'failed',
          safety_note: `Staging failed: ${stageResult.reason}`,
        });
        return { exitCode: 1, state };
      }

      finalChangedFiles = updatePaths;
      state.expected_changed_files = finalChangedFiles;
      saveWorkspaceSnapshot(runsDir, task.id, 'checking', taskBaseSha, finalChangedFiles, candidatePath);

      const checkResult = runChecks(candidatePath, candidateTask.checks);
      lastCheckResult = checkResult;
      if (!checkResult.success) {
        log(prefix, `Checks failed on attempt ${attempt}`);
        if (manifest && manifest.length > 0) {
          try {
            rollbackFileUpdates(candidatePath, manifest);
          } catch {
            // ignore
          }
        }
        if (attempt < maxAttempts) {
          repairPrompt = buildCheckRepairPrompt(task, task.work_branch, checkResult, kimiOutput.files);
          continue;
        }
        setPhase('failed', {
          status: 'failed',
          safety_note: `Checks failed after ${attempt} attempt(s): ${checkResult.logs}`,
        });
        return { exitCode: 1, state };
      }

      break;
    }

    if (finalKimiOutput === undefined) {
      log(prefix, 'No effective Kimi output produced after all attempts');
      setPhase('failed', {
        status: 'failed',
        safety_note: 'No effective Kimi output produced after all attempts',
      });
      return { exitCode: 1, state };
    }
  }

  // Reviewer gate and optional fix loop.
  let currentReviewerGate: PersistedReviewerGate | undefined = state.reviewer_gate;
  let acceptedReviewPackage: CandidateReviewPackage | undefined;

  if (skipToAcceptance) {
    log(prefix, 'Resuming after acceptance; skipping reviewer gate');
  } else {
    const enableFixLoop = process.env.REAL_REPO_ENABLE_REVIEWER_FIX_LOOP !== '0';

    for (let reviewerRound = 0; reviewerRound <= reviewerMaxFixAttempts; reviewerRound++) {
      setPhase(reviewerRound === 0 ? 'reviewer_pending' : 'reviewer_fix_pending');

      const diffInfo = getCandidateDiff(candidatePath, taskBaseSha);
      const checkSummary = buildCheckSummary(candidateTask.checks, lastCheckResult?.success ?? true);
      const reviewPackage = buildCandidateReviewPackage({
        candidatePath,
        taskBaseSha,
        task: candidateTask,
        checkSummary,
        dependencyEvidence: task.dependency_evidence,
      });
      saveCandidateReviewPackage(runsDir, task.id, reviewPackage);

      const evidence = buildCandidateReviewerEvidence({
        repoPath: candidatePath,
        taskId: task.id,
        taskGoal: task.goal,
        branchName: task.work_branch,
        taskBaseSha,
        checkSummary,
        acceptance_criteria: task.acceptance_criteria,
        allowedFiles: task.guardrails.allow_modify ?? [],
        stateStatus: reviewerRound === 0 ? 'candidate_review' : 'fix_candidate_review',
        dependencyEvidence: task.dependency_evidence,
      });

      const fakeReviewerResponse = process.env.REAL_REPO_REVIEWER_FAKE_RESPONSE;
      const reviewerResponse =
        reviewerRound === 0
          ? fakeReviewerResponse
          : secondReviewerFakeResponses[reviewerRound - 1] ??
            process.env.REAL_REPO_REVIEWER_SECOND_FAKE_RESPONSE ??
            fakeReviewerResponse;

      let gateResult: PersistedReviewerGate;

      try {
        const reviewerResult = await runReviewerGateWithProvider({
          evidence,
          reviewer: async (reviewerInput) => {
            if (reviewerResponse) {
              return reviewerResponse;
            }
            const reviewerProvider = createKimiReviewerProvider(
              { provider: 'kimi', apiKey, baseUrl, model, userAgent },
              {
                allowReal: true,
                fakeResponse: process.env.KIMI_FAKE_REVIEWER_RESPONSE,
                fetchFn: typeof globalThis.fetch === 'function' ? (globalThis.fetch as unknown as FetchFn) : fetchFn,
              }
            );
            const providerInput = buildReviewInput({
              taskId: task.id,
              repoPath: candidatePath,
              taskTitle: task.title,
              taskGoal: task.goal,
              allowedFiles: task.guardrails.allow_modify ?? [],
              deniedFiles: task.guardrails.deny_modify,
              maxLinesChanged: task.guardrails.max_lines_changed,
              acceptanceCriteria: reviewerInput.acceptance_criteria,
              commitSha: taskBaseSha,
              changedFiles: diffInfo.changedFiles,
              diff: diffInfo.diff,
              typecheckResult: reviewerInput.checkSummary.typecheck ?? 'pass',
              buildResult: reviewerInput.checkSummary.build ?? 'pass',
              testResult: reviewerInput.checkSummary.test ?? 'pass',
              gitStatus: '',
              safetyFindings: [],
              dependencyEvidence: reviewerInput.dependency_evidence,
              candidateState: {
                base_sha: reviewPackage.task_base_sha,
                package_hash: reviewPackage.candidate_package_hash,
                files: reviewPackage.files,
              },
              readOnlyContext: {
                files: reviewPackage.read_only_context,
                total_bytes: reviewPackage.read_only_context_total_bytes,
                truncated: reviewPackage.read_only_context_truncated,
              },
            });
            const decision = await reviewerProvider.reviewCommit(providerInput);
            const mappedDecision =
              decision.next_action === 'advance_to_next_task'
                ? 'accept'
                : decision.next_action === 'send_fix_to_coder'
                  ? 'reject'
                  : 'block_for_human';
            const mappedNextAction =
              decision.next_action === 'advance_to_next_task'
                ? 'continue'
                : decision.next_action === 'send_fix_to_coder'
                  ? 'fix'
                  : 'block';
            return JSON.stringify({
              decision: mappedDecision,
              confidence: decision.confidence,
              blockingIssues: decision.blocking_issues,
              nonBlockingIssues: decision.non_blocking_issues,
              reviewSummary: decision.review_summary,
              nextAction: mappedNextAction,
              fixTask: decision.fix_task ?? undefined,
            });
          },
          maxParseRetries: reviewerParseRetries,
        });
        const gate = reviewerResult.gateResult;
        gateResult = {
          status: gate.status,
          source: gate.source,
          nextAction: gate.nextAction,
          blockingIssues: gate.blockingIssues.map((i) => redactSecrets(i)),
          nonBlockingIssues: gate.nonBlockingIssues.map((i) => redactSecrets(i)),
          reviewSummary: redactSecrets(gate.reviewSummary),
          fixTask: gate.fixTask ? redactSecrets(gate.fixTask) : undefined,
        };
        allProviderAttempts.push({
          attempt: nextProviderAttemptNumber++,
          ok: gateResult.status === 'accepted',
          type: reviewerRound === 0 ? 'reviewer' : 'second_reviewer',
          reason: `Reviewer gate ${gateResult.status}`,
        });
        state.provider_attempts = allProviderAttempts;
      } catch (reviewerErr) {
        const msg = reviewerErr instanceof Error ? reviewerErr.message : String(reviewerErr);
        log(prefix, `Reviewer gate error: ${redactSecrets(msg)}`);
        gateResult = {
          status: 'blocked',
          source: 'provider',
          nextAction: 'block',
          blockingIssues: [redactSecrets(msg)],
          nonBlockingIssues: [],
          reviewSummary: 'Reviewer gate unexpected error.',
        };
        allProviderAttempts.push({
          attempt: nextProviderAttemptNumber++,
          ok: false,
          type: reviewerRound === 0 ? 'reviewer' : 'second_reviewer',
          reason: `Reviewer gate error: ${redactSecrets(msg)}`,
        });
        state.provider_attempts = allProviderAttempts;
      }

      currentReviewerGate = gateResult;
      state.reviewer_gate = gateResult;
      state.reviewer_phase_evidence = {
        ...(state.reviewer_phase_evidence ?? {}),
        reviewer_started_at: state.reviewer_phase_evidence?.reviewer_started_at ?? nowIso(),
        reviewer_result: {
          status: gateResult.status,
          source: gateResult.source,
          nextAction: gateResult.nextAction,
          blockingIssues: gateResult.blockingIssues,
          nonBlockingIssues: gateResult.nonBlockingIssues,
          reviewSummary: gateResult.reviewSummary,
          fixTask: gateResult.fixTask,
        },
      };

      if (gateResult.status === 'accepted') {
        acceptedReviewPackage = reviewPackage;
        break;
      }

      if (gateResult.status !== 'fix_required' || !enableFixLoop) {
        setPhase('blocked', {
          status: 'blocked',
          safety_note: gateResult.reviewSummary,
        });
        return { exitCode: 1, state };
      }

      if (reviewerRound >= reviewerMaxFixAttempts) {
        log(prefix, `Max reviewer fix attempts (${reviewerMaxFixAttempts}) reached`);
        setPhase('blocked', {
          status: 'blocked',
          safety_note: `Max reviewer fix attempts reached: ${gateResult.reviewSummary}`,
        });
        return { exitCode: 1, state };
      }

      // Run a fix coder iteration in the same candidate workspace.
      fixAttempted = true;
      log(prefix, `Reviewer fix required; running fix attempt ${reviewerRound + 1}/${reviewerMaxFixAttempts}`);
      state.reviewer_phase_evidence = {
        ...(state.reviewer_phase_evidence ?? {}),
        fix_task_created: true,
        fix_started_at: nowIso(),
      };

      const fixInput = {
        executionRequest: {
          kind: 'reviewer_fix_task' as const,
          status: 'pending' as const,
          source: 'reviewer_gate' as const,
          taskId: `fix-${task.id}-${reviewerRound + 1}`,
          parentTaskId: task.id,
          attempt: reviewerRound + 1,
          title: `Fix ${task.title}`,
          goal: gateResult.fixTask ?? `Address reviewer blocking issues: ${gateResult.blockingIssues.join('; ')}`,
          blockingIssues: gateResult.blockingIssues,
          task: {
            taskId: `fix-${task.id}-${reviewerRound + 1}`,
            parentTaskId: task.id,
            attempt: reviewerRound + 1,
            title: `Fix ${task.title}`,
            goal: gateResult.fixTask ?? `Address reviewer blocking issues: ${gateResult.blockingIssues.join('; ')}`,
            source: 'reviewer_gate' as const,
            blockingIssues: gateResult.blockingIssues,
          },
        },
        fixTask: {
          taskId: `fix-${task.id}-${reviewerRound + 1}`,
          parentTaskId: task.id,
          attempt: reviewerRound + 1,
          title: `Fix ${task.title}`,
          goal: gateResult.fixTask ?? `Address reviewer blocking issues: ${gateResult.blockingIssues.join('; ')}`,
          source: 'reviewer_gate' as const,
          blockingIssues: gateResult.blockingIssues,
        },
        taskId: `fix-${task.id}-${reviewerRound + 1}`,
        parentTaskId: task.id,
        attempt: reviewerRound + 1,
        title: `Fix ${task.title}`,
        goal: gateResult.fixTask ?? `Address reviewer blocking issues: ${gateResult.blockingIssues.join('; ')}`,
        blockingIssues: gateResult.blockingIssues,
      };

      const previousChangedFiles = finalChangedFiles;
      const fixPrompt = buildFixTaskPrompt(fixInput, {
        parentGoal: task.goal,
        allowedFiles: task.guardrails.allow_modify ?? [],
        deniedFiles: task.guardrails.deny_modify,
        previousChangedFiles,
        checks: task.checks,
        currentHead: taskBaseSha,
        dependencyEvidence: task.dependency_evidence,
        currentCandidateFiles: reviewPackage.files,
        readOnlyContext: reviewPackage.read_only_context,
        previousReviewerSummary: gateResult.reviewSummary,
      });

      const fixResponseForRound = fixKimiFakeResponses[reviewerRound];
      const fixProviderCall =
        fixResponseForRound !== undefined && fixResponseForRound !== ''
          ? createMockProviderCall(fixResponseForRound)
          : createRealProviderCall({
              provider: 'kimi',
              apiKey,
              baseUrl,
              fetchFn,
              model,
              userAgent,
            });

      const fixPipeline = await runCoderProviderPipeline({
        taskId: fixInput.taskId,
        repoPath: candidatePath,
        basePrompt: fixPrompt,
        providerCall: fixProviderCall,
        provider: 'kimi',
        model,
        providerAttemptType: 'reviewer_fix_coder',
        startingGlobalAttemptNumber: nextProviderAttemptNumber,
        logPrefix: `${prefix}[fix]`,
      });

      allProviderAttempts.push(...fixPipeline.providerAttempts);
      nextProviderAttemptNumber = fixPipeline.nextGlobalAttemptNumber;
      state.provider_attempts = allProviderAttempts;

      if (!fixPipeline.success) {
        log(prefix, `Fix coder pipeline failed: ${fixPipeline.reason}`);
        setPhase('blocked', {
          status: 'blocked',
          safety_note: `Fix coder pipeline failed: ${fixPipeline.reason}`,
        });
        return { exitCode: 1, state };
      }

      const effectiveFixAttempt = allProviderAttempts[allProviderAttempts.length - 1];
      if (effectiveFixAttempt) {
        effectiveFixAttempt.classification = 'EFFECTIVE_CHANGES';
      }

      const fixKimiOutput = fixPipeline.kimiOutput;
      const fixUpdatePaths = fixKimiOutput.files.map((f) => f.path);

      const fixGuardrails = validateFileList(fixUpdatePaths, candidateTask.guardrails);
      if (!fixGuardrails.ok) {
        log(prefix, `Fix guardrails failed: ${fixGuardrails.reason}`);
        setPhase('blocked', {
          status: 'blocked',
          safety_note: `Fix guardrails failed: ${fixGuardrails.reason}`,
          safety_policy_reasons: [fixGuardrails.reason ?? 'unknown guardrails violation'],
        });
        return { exitCode: 1, state };
      }

      const fixSafetyPolicy = validateAiSafetyPolicy({
        repoPath: candidatePath,
        allowedFiles: candidateTask.guardrails.allow_modify,
        deniedFiles: candidateTask.guardrails.deny_modify,
        files: fixKimiOutput.files,
      });
      if (!fixSafetyPolicy.ok) {
        const policyMessage = fixSafetyPolicy.reasons.join('; ');
        log(prefix, `Fix safety policy violation: ${policyMessage}`);
        setPhase('blocked', {
          status: 'blocked',
          blocked_by: 'safety_policy',
          safety_note: `Fix safety policy violation: ${policyMessage}`,
          safety_policy_reasons: fixSafetyPolicy.reasons,
        });
        return { exitCode: 1, state };
      }

      const fixExistingPaths: string[] = [];
      for (const f of fixKimiOutput.files) {
        if (existsSync(resolve(candidatePath, f.path))) {
          fixExistingPaths.push(f.path);
        }
      }
      const fixPlan = buildRealRepoApplyPlan({
        taskId: fixInput.taskId,
        attempt: 1,
        existingPaths: fixExistingPaths,
        files: fixKimiOutput.files,
      });
      if (!fixPlan.ok) {
        log(prefix, `Fix apply plan failed: ${fixPlan.reason}`);
        setPhase('blocked', {
          status: 'blocked',
          safety_note: `Fix apply plan failed: ${fixPlan.reason}`,
          safety_policy_reasons: fixPlan.safetyMessages,
        });
        return { exitCode: 1, state };
      }

      let fixManifest: import('./types.js').PatchManifestEntry[] | undefined;
      try {
        fixManifest = applyFileUpdates(candidatePath, fixKimiOutput.files, fixPlan.runDir);
      } catch (applyErr) {
        const applyMessage = applyErr instanceof Error ? applyErr.message : String(applyErr);
        log(prefix, `Fix apply failed: ${applyMessage}`);
        setPhase('blocked', {
          status: 'blocked',
          safety_note: `Fix apply failed: ${applyMessage}`,
        });
        return { exitCode: 1, state };
      }

      const fixChanges = getRepoWorkingTreeChanges(candidatePath);
      const fixApprovedPaths = new Set([...finalChangedFiles, ...fixUpdatePaths]);
      const fixUnrelated = fixChanges.all.filter((p) => !fixApprovedPaths.has(p));
      if (fixUnrelated.length > 0) {
        log(prefix, `Unauthorized fix modification: ${fixUnrelated.join(', ')}`);
        if (fixManifest) {
          try {
            rollbackFileUpdates(candidatePath, fixManifest);
          } catch {
            // ignore
          }
        }
        setPhase('blocked', {
          status: 'blocked',
          safety_note: `Unauthorized fix modification: ${fixUnrelated.join(', ')}`,
          safety_policy_reasons: [`Unauthorized fix modification: ${fixUnrelated.join(', ')}`],
        });
        return { exitCode: 1, state };
      }

      const fixStage = stageCandidateFiles(candidatePath, fixUpdatePaths);
      if (!fixStage.ok) {
        log(prefix, `Fix staging failed: ${fixStage.reason}`);
        setPhase('blocked', {
          status: 'blocked',
          safety_note: `Fix staging failed: ${fixStage.reason}`,
        });
        return { exitCode: 1, state };
      }

      finalChangedFiles = [...new Set([...finalChangedFiles, ...fixUpdatePaths])];
      state.expected_changed_files = finalChangedFiles;
      saveWorkspaceSnapshot(runsDir, task.id, 'reviewer_fix_pending', taskBaseSha, finalChangedFiles, candidatePath);

      const fixCheckResult = runChecks(candidatePath, candidateTask.checks);
      lastCheckResult = fixCheckResult;
      if (!fixCheckResult.success) {
        log(prefix, `Fix checks failed: ${fixCheckResult.logs}`);
        if (fixManifest) {
          try {
            rollbackFileUpdates(candidatePath, fixManifest);
          } catch {
            // ignore
          }
        }
        setPhase('blocked', {
          status: 'blocked',
          safety_note: `Fix checks failed: ${fixCheckResult.logs}`,
        });
        return { exitCode: 1, state };
      }

      finalKimiOutput = fixKimiOutput;
    }
  }

  if (!skipToAcceptance && currentReviewerGate?.status !== 'accepted') {
    log(prefix, `Reviewer gate ended with non-accepted status: ${currentReviewerGate?.status ?? 'unknown'}`);
    setPhase('blocked', {
      status: 'blocked',
      safety_note: `Reviewer gate ended with status ${currentReviewerGate?.status ?? 'unknown'}`,
    });
    return { exitCode: 1, state };
  }

  // Acceptance: final checks, persist accepted snapshot, then commit/push with
  // deterministic reconciliation. This block is idempotent across crashes.
  const finalCheck = runChecks(candidatePath, candidateTask.checks);
  if (!finalCheck.success) {
    log(prefix, `Final checks failed: ${finalCheck.logs}`);
    setPhase('blocked', {
      status: 'blocked',
      safety_note: `Final checks failed: ${finalCheck.logs}`,
    });
    return { exitCode: 1, state };
  }

  // Fail-closed binding: the candidate that is about to be committed must be the
  // exact candidate the reviewer accepted. Any drift after the review verdict is a
  // safety violation.
  if (!skipToAcceptance) {
    if (!acceptedReviewPackage) {
      const reason = 'Accepted candidate package is missing; cannot bind commit to reviewer verdict';
      log(prefix, reason);
      setPhase('failed', { status: 'failed', safety_note: reason });
      return { exitCode: 1, state };
    }
    const currentPackage = buildCandidateReviewPackage({
      candidatePath,
      taskBaseSha,
      task: candidateTask,
      checkSummary: buildCheckSummary(candidateTask.checks, finalCheck.success),
      dependencyEvidence: task.dependency_evidence,
    });
    if (currentPackage.candidate_package_hash !== acceptedReviewPackage.candidate_package_hash) {
      const reason = `Accepted candidate package hash mismatch: expected ${acceptedReviewPackage.candidate_package_hash}, got ${currentPackage.candidate_package_hash}`;
      log(prefix, reason);
      setPhase('failed', { status: 'failed', safety_note: reason });
      return { exitCode: 1, state };
    }
  }

  // Persist the accepted candidate before creating a commit so a crash after the
  // commit can still be reconciled against the intended content.
  saveWorkspaceSnapshot(runsDir, task.id, 'accepted', taskBaseSha, state.expected_changed_files ?? [], candidatePath);
  setPhase('accepted', { status: 'approved' });

  let snapshot = loadLatestCandidateSnapshot(runsDir, task.id);
  if (!snapshot) {
    const reason = 'Accepted candidate snapshot missing; cannot reconcile commit/push state';
    log(prefix, reason);
    setPhase('failed', { status: 'failed', safety_note: reason });
    return { exitCode: 1, state };
  }

  const reconcileResult = reconcileCandidateWorkspace(candidatePath, taskBaseSha, task.work_branch, snapshot);
  if (!reconcileResult.ok) {
    log(prefix, `Reconcile failed: ${reconcileResult.reason}`);
    setPhase('failed', { status: 'failed', safety_note: `Reconcile failed: ${reconcileResult.reason}` });
    return { exitCode: 1, state };
  }

  const commitMessage = `ai-orchestrator: ${task.id}`;
  let acceptedCommitSha = reconcileResult.acceptedCommitSha;

  if (reconcileResult.commitNeeded) {
    // Final pre-commit validation: workspace must still be at the immutable task base
    // with exactly the expected files staged.
    const finalValidation = validateCandidateWorkspace(
      candidatePath,
      taskBaseSha,
      state.expected_changed_files
    );
    if (!finalValidation.ok) {
      log(prefix, `Final candidate validation failed: ${finalValidation.reason}`);
      setPhase('blocked', {
        status: 'blocked',
        safety_note: `Final candidate validation failed: ${finalValidation.reason}`,
      });
      return { exitCode: 1, state };
    }

    const commitResult = git(['commit', '-m', commitMessage, '--no-gpg-sign'], candidatePath, true);
    if (commitResult.status !== 0) {
      log(prefix, `Commit failed: ${commitResult.stderr.trim()}`);
      setPhase('failed', {
        status: 'failed',
        safety_note: `Commit failed: ${commitResult.stderr.trim()}`,
      });
      return { exitCode: 1, state };
    }

    const headResult = git(['rev-parse', '--verify', 'HEAD'], candidatePath, true);
    if (headResult.status !== 0) {
      log(prefix, 'Failed to read commit SHA after commit');
      setPhase('failed', {
        status: 'failed',
        safety_note: 'Failed to read commit SHA after commit',
      });
      return { exitCode: 1, state };
    }
    const commitSha = headResult.stdout.trim();
    if (!VALID_SHA.test(commitSha)) {
      log(prefix, `Commit SHA is not valid: ${commitSha}`);
      setPhase('failed', {
        status: 'failed',
        safety_note: `Commit SHA is not valid: ${commitSha}`,
      });
      return { exitCode: 1, state };
    }

    const parent = getCommitParent(candidatePath, commitSha);
    if (parent !== taskBaseSha) {
      const reason = `Accepted commit parent ${parent ?? 'unknown'} != task_base_sha ${taskBaseSha}`;
      log(prefix, reason);
      setPhase('failed', { status: 'failed', safety_note: reason });
      return { exitCode: 1, state };
    }

    const verify = verifyCommitAgainstSnapshot(candidatePath, commitSha, snapshot);
    if (!verify.ok) {
      log(prefix, `Committed content does not match accepted snapshot: ${verify.reason}`);
      setPhase('failed', {
        status: 'failed',
        safety_note: `Committed content does not match accepted snapshot: ${verify.reason}`,
      });
      return { exitCode: 1, state };
    }

    acceptedCommitSha = commitSha;
    setPhase('committed', { accepted_commit_sha: commitSha });
  }

  if (!acceptedCommitSha) {
    const reason = 'Reconciliation succeeded but produced no accepted commit SHA';
    log(prefix, reason);
    setPhase('failed', { status: 'failed', safety_note: reason });
    return { exitCode: 1, state };
  }

  const originUrl = getGitRemoteUrl(candidatePath, 'origin') ?? getGitRemoteUrl(task.repo_path, 'origin') ?? '';
  if (originUrl) {
    const remoteConfig = configureCandidateRemote(candidatePath, originUrl);
    if (!remoteConfig.ok) {
      const reason = redactSecrets(`Remote configuration failed: ${remoteConfig.reason ?? 'unknown'}`);
      log(prefix, reason);
      setPhase('failed', {
        status: 'failed',
        committed: true,
        commit_sha: acceptedCommitSha,
        accepted_commit_sha: acceptedCommitSha,
        safety_note: reason,
      });
      return { exitCode: 1, state };
    }
  }

  if (reconcileResult.pushNeeded) {
    const pushResult = pushCandidateCommit(candidatePath, task.work_branch);
    if (!pushResult.ok) {
      log(prefix, `Push failed: ${pushResult.reason}`);
      setPhase('failed', {
        status: 'failed',
        committed: true,
        commit_sha: acceptedCommitSha,
        accepted_commit_sha: acceptedCommitSha,
        safety_note: `Push failed: ${pushResult.reason}`,
      });
      return { exitCode: 1, state };
    }

    const remoteHeadAfterPush = getRemoteBranchHead(candidatePath, task.work_branch);
    if (remoteHeadAfterPush !== acceptedCommitSha) {
      const reason = `Remote HEAD ${remoteHeadAfterPush ?? 'missing'} does not match accepted commit ${acceptedCommitSha}`;
      log(prefix, reason);
      setPhase('failed', {
        status: 'failed',
        committed: true,
        commit_sha: acceptedCommitSha,
        accepted_commit_sha: acceptedCommitSha,
        safety_note: reason,
      });
      return { exitCode: 1, state };
    }
  }

  const ffResult = fastForwardMissionBranch(task.repo_path, task.work_branch, acceptedCommitSha);
  if (!ffResult.ok) {
    log(prefix, `Fast-forward mission branch failed: ${ffResult.reason}`);
    setPhase('failed', {
      status: 'failed',
      committed: true,
      pushed: reconcileResult.pushNeeded || reconcileResult.alreadyPushed,
      commit_sha: acceptedCommitSha,
      accepted_commit_sha: acceptedCommitSha,
      safety_note: `Fast-forward mission branch failed: ${ffResult.reason}`,
    });
    return { exitCode: 1, state };
  }

  setPhase('pushed', {
    status: 'pushed',
    commit_sha: acceptedCommitSha,
    accepted_commit_sha: acceptedCommitSha,
    fixed_and_accepted: fixAttempted,
    fix_check_summary: fixAttempted ? buildCheckSummary(candidateTask.checks, lastCheckResult?.success ?? true) : undefined,
    check_summary: buildCheckSummary(candidateTask.checks, lastCheckResult?.success ?? true),
    pushed: true,
    pushed_remote: 'origin',
    pushed_ref: task.work_branch,
    applied: true,
    committed: true,
  });

  cleanupCandidateWorkspace(candidatePath);

  log(prefix, 'Reviewer gate accepted');
  log(prefix, `Commit created: ${acceptedCommitSha}`);
  log(prefix, 'Push completed');
  log(prefix, 'State written');
  log(prefix, 'Human review required before merge');

  return { exitCode: 0, state };
}

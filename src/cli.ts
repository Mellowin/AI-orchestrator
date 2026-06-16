#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadTask } from './task-loader.js';
import { loadState, saveState, initState, getRunDir } from './state-manager.js';
import { buildContext } from './context-builder.js';
import { validateFileList, validateProposedFileLineDeltas } from './guardrails.js';
import { applyFileUpdates, rollbackFileUpdates } from './patch-engine.js';
import { runChecks } from './runner.js';
import {
  ensureClean,
  getCurrentBranch,
  branchExists,
  getChangedFiles,
  getDiffStat,
} from './git-manager.js';
import { parseKimiOutputJson } from './kimi-output-validator.js';
import type { KimiOutput, RunState } from './types.js';
import { buildKimiPrompt } from './prompt-builder.js';
import { runMockApplyFlow } from './mock-apply-flow.js';
import { runPipelineLoop } from './pipeline-loop.js';
import { config } from './config.js';
import { createAIClientFromConfig } from './ai-client-factory.js';
import { resolveBackupPath } from './backup-path.js';
import { buildAgentPlan, parseAgentOnceArgs, type AgentPlanMode } from './agent-plan.js';
import { createMockProviderCall, createRealProviderCall, buildProviderCallInput, normalizeProviderCallResult, normalizeProviderCallError } from './provider-call.js';
import type { FetchFn } from './provider-call.js';
import { runSandboxApplyFlow } from './sandbox-apply-flow.js';
import { runRealRepoSandboxPreflight } from './real-repo-sandbox-preflight.js';
import { buildSandboxPreflightRepairDecision, redactSecrets } from './sandbox-preflight-repair.js';
import { validateRealRepoApplySafety } from './real-repo-apply-safety.js';
import { buildRealRepoApplyDryRunSummary } from './real-repo-apply-dry-run.js';
import { buildRealRepoApplyPlan } from './real-repo-apply-plan.js';
import { ProviderRegistry } from './providers/provider-registry.js';
import { createFakeCoderProvider } from './providers/fake/fake-coder-provider.js';
import { createFakeReviewerProvider } from './providers/fake/fake-reviewer-provider.js';
import { createKimiCoderProvider } from './providers/kimi/kimi-coder-provider.js';
import { createKimiReviewerProvider } from './providers/kimi/kimi-reviewer-provider.js';
import { validateReviewerDecision } from './reviewer/reviewer-schema.js';
import { buildCommitEvidence, validateCommitSha } from './reviewer/commit-verifier.js';
import { runDeterministicReviewChecks } from './reviewer/deterministic-review-checks.js';
import { buildReviewInput } from './reviewer/review-input-builder.js';
import { runReviewerGate } from './reviewer/reviewer-gate.js';
import { runCommittedTaskReviewerGate } from './committed-task-reviewer-gate.js';
import { deriveReviewerBlockReviewResult } from './reviewer-block-review-result.js';
import { readPendingReviewerFixTaskState } from './reviewer-pending-fix-task-state.js';
import { derivePendingReviewerFixTaskExecutionPlan } from './reviewer-pending-fix-task-execution-plan.js';
import { derivePendingReviewerFixTaskExecutionRequest } from './reviewer-pending-fix-task-execution-request.js';
import { readPendingReviewerFixTaskExecutionRequestState } from './reviewer-pending-fix-task-execution-request-state.js';
import { deriveReviewerFixTaskRunPlan } from './reviewer-fix-task-run-plan.js';
import { readReviewerFixTaskRunPlanState } from './reviewer-fix-task-run-plan-state.js';
import { runReviewerFixTaskControlled } from './reviewer-fix-task-controlled-run.js';
import { deriveReviewerFixTaskPostRunReviewPlan } from './reviewer-fix-task-post-run-review-plan.js';
import { createReviewerFixTaskRealExecutor } from './reviewer-fix-task-real-executor.js';
import type { ReviewerGateStatus, ReviewerGateDecisionSource } from './reviewer-gate.js';
import { loadBlockDefinition } from './block/block-loader.js';
import { initBlockState, loadBlockState, saveBlockState, updateBlockState } from './block/block-state-manager.js';
import {
  markTaskInProgress,
  markTaskCoderDone,
  markTaskChecksFailed,
  markTaskCommitted,
  markTaskPushed,
  markTaskWaitingReview,
  markTaskAccepted,
  markTaskRejected,
  markTaskFixRequired,
  markTaskBlocked,
} from './block/block-transitions.js';
import { buildBlockStatusReport } from './block/block-report.js';
import { runOneTaskLoop } from './block/block-one-task-loop.js';
import { runMultiTaskLoop, runMultiTaskFakeLoop } from './block/block-multi-task-loop.js';
import { runRealBlockRunAI } from './real-block-run-ai.js';
import { runRealProviderSmoke } from './real-provider-smoke.js';
import { runRealCoderContractSmoke, formatRealCoderContractSmokeReport } from './real-coder-contract-smoke.js';
import { runRealReviewerContractSmoke, formatRealReviewerContractSmokeReport } from './real-reviewer-contract-smoke.js';
import { checkRealBlockRunReadiness } from './real-block-run-ai-readiness.js';
import { renderBlockRunReport } from './real-block-run-ai-report.js';
import { checkRealBlockRunAIChecklist, formatCheckRealBlockRunAIChecklistReport } from './real-block-run-ai-checklist.js';
import { createRealBlockRunAIDryRunReport, formatRealBlockRunAIDryRunReport } from './real-block-run-ai-dry-run.js';
import { createRealBlockInitFile, formatRealBlockInitReport, getFlagValue } from './real-block-init.js';
import { validateRealBlockFile, formatRealBlockValidateReport } from './real-block-validate.js';
import { runRealBlockPreflight, formatRealBlockPreflightReport } from './real-block-preflight.js';
import { runRealBlockTaskProbe, formatRealBlockTaskProbeReport } from './real-block-task-probe.js';

function countLines(text: string): number {
  if (text.length === 0) return 0;
  const lines = text.split('\n');
  return text.endsWith('\n') ? lines.length - 1 : lines.length;
}

function validateMaxAttempts(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') {
    return 2;
  }
  const num = Number(raw.trim());
  if (!Number.isInteger(num) || num < 1 || num > 3) {
    throw new Error(`Invalid REAL_REPO_AI_MAX_ATTEMPTS: "${raw}". Must be an integer between 1 and 3.`);
  }
  return num;
}

function buildRepairPrompt(
  task: import('./types.js').Task,
  branch: string,
  checkResult: import('./types.js').RunResult,
  previousFiles: Array<{ path: string; content: string }>
): string {
  const failedCommand = checkResult.failedStep
    ? `${checkResult.failedStep.command} ${checkResult.failedStep.args.join(' ')}`
    : 'unknown';
  const previousPaths = previousFiles.map((f) => f.path).join(', ');

  return (
    `# Task (Repair Attempt)\n\n` +
    `Task ID: ${task.id}\n` +
    `Branch: ${branch}\n` +
    `Title: ${task.title}\n` +
    `Goal: ${task.goal}\n\n` +
    `# Previous Attempt Failed\n\n` +
    `Failed check command: ${failedCommand}\n\n` +
    `Check output summary:\n${checkResult.logs}\n\n` +
    `Previously proposed files: ${previousPaths}\n\n` +
    `# Instructions\n\n` +
    `Fix the issue that caused the check to fail. ` +
    `Return ONLY valid JSON using the file_update schema. ` +
    `Return full file content, not diffs. ` +
    `Do not include markdown outside JSON. ` +
    `Do not modify files outside allowed scope.`
  );
}

function getTasksFilePath(): string {
  return process.env.TASKS_FILE?.trim() || 'tasks.yaml';
}

function validateKimiOutputForTask(raw: string, taskId: string): KimiOutput {
  const kimiOutput = parseKimiOutputJson(raw);
  const task = loadTask(getTasksFilePath(), taskId);
  const updatePaths = kimiOutput.files.map((f) => f.path);
  const guardrailsResult = validateFileList(updatePaths, task.guardrails);
  if (!guardrailsResult.ok) {
    throw new Error(`Guardrails failed: ${guardrailsResult.reason}`);
  }
  return kimiOutput;
}

async function executeAiGenerate(taskId: string, allowRealAI: boolean): Promise<{ outputPath: string; backupPath?: string }> {
  const task = loadTask(getTasksFilePath(), taskId);
  const context = buildContext(task);
  const prompt = buildKimiPrompt(context);

  if (config.ai.provider !== 'mock' && !allowRealAI) {
    throw new Error('real AI providers require --allow-real-ai');
  }

  const client = createAIClientFromConfig(config.ai);
  const output = await client.generate(prompt);

  const runDir = getRunDir(taskId);
  if (!existsSync(runDir)) {
    mkdirSync(runDir, { recursive: true });
  }
  const outPath = join(runDir, 'ai-output.json');
  let backupPath: string | undefined;
  if (existsSync(outPath)) {
    backupPath = resolveBackupPath(runDir, new Date());
    const oldContent = readFileSync(outPath, 'utf-8');
    writeFileSync(backupPath, oldContent, 'utf-8');
  }
  writeFileSync(outPath, output, 'utf-8');
  return { outputPath: outPath, backupPath };
}

function executeAiValidate(taskId: string): KimiOutput {
  const outputPath = join(getRunDir(taskId), 'ai-output.json');
  if (!existsSync(outputPath)) {
    throw new Error('ai-output.json not found. Run ai-generate first.');
  }
  if (!statSync(outputPath).isFile()) {
    throw new Error('ai-output.json is not a file');
  }
  const raw = readFileSync(outputPath, 'utf-8');
  return validateKimiOutputForTask(raw, taskId);
}

function executeAiPreview(taskId: string): { filesCount: number; notes?: string } {
  const outputPath = join(getRunDir(taskId), 'ai-output.json');
  if (!existsSync(outputPath)) {
    throw new Error('ai-output.json not found. Run ai-generate first.');
  }
  if (!statSync(outputPath).isFile()) {
    throw new Error('ai-output.json is not a file');
  }
  const raw = readFileSync(outputPath, 'utf-8');
  const kimiOutput = validateKimiOutputForTask(raw, taskId);
  const task = loadTask(getTasksFilePath(), taskId);

  if (kimiOutput.files.length > 0) {
    validateProposedFileLineDeltas(
      task.repo_path,
      kimiOutput.files,
      task.guardrails.max_lines_changed
    );

    for (const file of kimiOutput.files) {
      const filePath = join(task.repo_path, file.path);
      const fileExists = existsSync(filePath);
      let currentLines = 0;
      if (fileExists) {
        currentLines = countLines(readFileSync(filePath, 'utf-8'));
      }
      const proposedLines = countLines(file.content);
      const delta = proposedLines - currentLines;
      const deltaStr = delta >= 0 ? `+${delta}` : `${delta}`;

      console.log(`  - ${file.path}`);
      console.log(`    exists: ${fileExists ? 'yes' : 'no'}`);
      console.log(`    current lines: ${currentLines}`);
      console.log(`    proposed lines: ${proposedLines}`);
      console.log(`    delta: ${deltaStr}`);
    }
  }

  return { filesCount: kimiOutput.files.length, notes: kimiOutput.notes };
}

const args = process.argv.slice(2);
const command = args[0];
const taskId = args[1];
const commitSha = args[2];

function getRepoWorkingTreeChanges(repoPath: string): { modified: string[]; staged: string[]; untracked: string[]; all: string[] } {
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

  const all = [...new Set([...modified, ...staged, ...untracked])];
  return { modified, staged, untracked, all };
}

commandDispatch: {

if (command === 'real-repo-commit') {
  try {
    if (!taskId) {
      console.error('[real-repo-commit] Error: task id is required');
      console.error('[real-repo-commit] No commit was made');
      console.error('[real-repo-commit] No push was performed');
      console.error('[real-repo-commit] No merge was performed');
      process.exit(1);
    }

    if (process.env.ALLOW_REAL_REPO_COMMIT !== 'true') {
      console.error('[real-repo-commit] ALLOW_REAL_REPO_COMMIT=true is required');
      console.error('[real-repo-commit] No commit was made');
      console.error('[real-repo-commit] No push was performed');
      console.error('[real-repo-commit] No merge was performed');
      process.exit(1);
    }

    if (process.env.ALLOW_REAL_REPO_APPLY !== 'true') {
      console.error('[real-repo-commit] ALLOW_REAL_REPO_APPLY=true is required');
      console.error('[real-repo-commit] No commit was made');
      console.error('[real-repo-commit] No push was performed');
      console.error('[real-repo-commit] No merge was performed');
      process.exit(1);
    }

    const rawProviderText = process.env.REAL_REPO_PROVIDER_RESPONSE?.trim();
    if (!rawProviderText) {
      console.error('[real-repo-commit] Error: REAL_REPO_PROVIDER_RESPONSE env var is required');
      console.error('[real-repo-commit] No commit was made');
      console.error('[real-repo-commit] No push was performed');
      console.error('[real-repo-commit] No merge was performed');
      process.exit(1);
    }

    const task = loadTask(getTasksFilePath(), taskId);
    const kimiOutput = parseKimiOutputJson(rawProviderText);

    const updatePaths = kimiOutput.files.map((f) => f.path);
    const guardrailsResult = validateFileList(updatePaths, task.guardrails);
    if (!guardrailsResult.ok) {
      console.error(`[real-repo-commit] Guardrails failed: ${guardrailsResult.reason}`);
      console.error('[real-repo-commit] No commit was made');
      console.error('[real-repo-commit] No push was performed');
      console.error('[real-repo-commit] No merge was performed');
      process.exit(1);
    }

    // Branch safety checks (read-only)
    const currentBranch = getCurrentBranch(task.repo_path);
    if (!currentBranch || currentBranch === 'HEAD') {
      throw new Error('Current branch is missing or detached HEAD');
    }
    if (currentBranch === 'main') {
      throw new Error('Current branch is main');
    }
    if (!task.work_branch) {
      throw new Error('task.work_branch is missing');
    }
    if (task.work_branch === 'main') {
      throw new Error('task.work_branch is main');
    }
    if (currentBranch !== task.work_branch) {
      throw new Error(`Branch mismatch: current=${currentBranch}, work_branch=${task.work_branch}`);
    }

    // Get approved paths
    const approvedPaths = new Set(updatePaths);

    // Inspect working tree using read-only git commands
    const { all } = getRepoWorkingTreeChanges(task.repo_path);

    // Verify at least one approved changed file
    const approvedChanged = all.filter((p) => approvedPaths.has(p));
    if (approvedChanged.length === 0) {
      throw new Error('No working tree changes match the approved apply manifest');
    }

    // Verify no unrelated changes
    const unrelated = all.filter((p) => !approvedPaths.has(p));
    if (unrelated.length > 0) {
      throw new Error(`Unrelated changes detected: ${unrelated.join(', ')}`);
    }

    // Pre-commit validation passed — stage approved files and create local commit
    const commitMessage = `ai-orchestrator: apply ${taskId}`;

    for (const p of approvedChanged) {
      const addResult = spawnSync('git', ['add', p], {
        cwd: task.repo_path,
        shell: false,
        encoding: 'utf-8',
      });
      if (addResult.status !== 0) {
        console.error('[real-repo-commit] Git add failed');
        console.error('[real-repo-commit] No commit was made');
        console.error('[real-repo-commit] No push was performed');
        console.error('[real-repo-commit] No merge was performed');
        process.exit(1);
      }
    }

    const commitResult = spawnSync('git', ['commit', '-m', commitMessage, '--no-gpg-sign'], {
      cwd: task.repo_path,
      shell: false,
      encoding: 'utf-8',
    });
    if (commitResult.status !== 0) {
      console.error('[real-repo-commit] Git commit failed');
      console.error('[real-repo-commit] Manual inspection required');
      console.error('[real-repo-commit] No push was performed');
      console.error('[real-repo-commit] No merge was performed');
      process.exit(1);
    }

    console.error('[real-repo-commit] Commit created');
    console.error(`[real-repo-commit] Commit message: ${commitMessage}`);
    console.error('[real-repo-commit] No push was performed');
    console.error('[real-repo-commit] No merge was performed');
    console.error('[real-repo-commit] Human review required before push');
    process.exit(0);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[real-repo-commit] Error: ${message}`);
    console.error('[real-repo-commit] No commit was made');
    console.error('[real-repo-commit] No push was performed');
    console.error('[real-repo-commit] No merge was performed');
    process.exit(1);
  }
}

if (command === 'real-repo-push') {
  try {
    if (!taskId) {
      console.error('[real-repo-push] Error: task id is required');
      console.error('[real-repo-push] No push was performed');
      console.error('[real-repo-push] No merge was performed');
      console.error('[real-repo-push] No checkout was performed');
      console.error('[real-repo-push] No main touch was performed');
      process.exit(1);
    }

    if (process.env.ALLOW_REAL_REPO_PUSH !== 'true') {
      console.error('[real-repo-push] ALLOW_REAL_REPO_PUSH=true is required');
      console.error('[real-repo-push] No push was performed');
      console.error('[real-repo-push] No merge was performed');
      console.error('[real-repo-push] No checkout was performed');
      console.error('[real-repo-push] No main touch was performed');
      process.exit(1);
    }

    const task = loadTask(getTasksFilePath(), taskId);

    if (!existsSync(task.repo_path)) {
      throw new Error('repo_path does not exist');
    }
    if (!task.work_branch) {
      throw new Error('task.work_branch is missing');
    }
    if (task.work_branch === 'main') {
      throw new Error('task.work_branch is main');
    }

    const currentBranch = getCurrentBranch(task.repo_path);
    if (!currentBranch || currentBranch === 'HEAD') {
      throw new Error('Current branch is missing or detached HEAD');
    }
    if (currentBranch === 'main') {
      throw new Error('Current branch is main');
    }
    if (currentBranch !== task.work_branch) {
      throw new Error(`Branch mismatch: current=${currentBranch}, work_branch=${task.work_branch}`);
    }

    // Working tree must be clean
    const statusResult = spawnSync('git', ['status', '--porcelain'], {
      cwd: task.repo_path,
      shell: false,
      encoding: 'utf-8',
    });
    if (statusResult.stdout && statusResult.stdout.trim().length > 0) {
      throw new Error('Working tree is not clean');
    }

    // Local HEAD commit must exist
    const headResult = spawnSync('git', ['rev-parse', '--verify', 'HEAD'], {
      cwd: task.repo_path,
      shell: false,
      encoding: 'utf-8',
    });
    if (headResult.status !== 0) {
      throw new Error('No local HEAD commit exists');
    }

    // Origin remote must exist
    const remoteResult = spawnSync('git', ['remote', 'get-url', 'origin'], {
      cwd: task.repo_path,
      shell: false,
      encoding: 'utf-8',
    });
    if (remoteResult.status !== 0) {
      throw new Error('Remote origin does not exist');
    }

    // Push
    const pushResult = spawnSync('git', ['push', 'origin', currentBranch], {
      cwd: task.repo_path,
      shell: false,
      encoding: 'utf-8',
    });
    if (pushResult.status !== 0) {
      console.error('[real-repo-push] Git push failed');
      console.error('[real-repo-push] Manual inspection required');
      console.error('[real-repo-push] No merge was performed');
      console.error('[real-repo-push] No checkout was performed');
      console.error('[real-repo-push] No main touch was performed');
      process.exit(1);
    }

    // Push succeeded — write state
    const headSha = headResult.stdout.trim();
    const now = new Date().toISOString();
    let existingState: RunState | null = null;
    try {
      existingState = loadState(taskId);
    } catch {
      // ignore load errors, treat as no existing state
    }
    const pushState: RunState = {
      task_id: taskId,
      status: 'pushed',
      current_attempt: existingState?.current_attempt ?? 0,
      branch: currentBranch,
      repo_path: task.repo_path,
      created_at: existingState?.created_at ?? now,
      updated_at: now,
      pushed_remote: 'origin',
      pushed_ref: currentBranch,
      commit_sha: headSha,
      safety_note: 'Push completed; merge not performed; human review required before merge',
    };

    try {
      saveState(taskId, pushState);
    } catch (stateErr) {
      console.error('[real-repo-push] Push completed');
      console.error('[real-repo-push] State write failed');
      console.error('[real-repo-push] Manual inspection required');
      console.error('[real-repo-push] No merge was performed');
      console.error('[real-repo-push] No checkout was performed');
      console.error('[real-repo-push] No main touch was performed');
      process.exit(1);
    }

    console.error('[real-repo-push] Push completed');
    console.error(`[real-repo-push] Push target: origin ${currentBranch}`);
    console.error('[real-repo-push] No merge was performed');
    console.error('[real-repo-push] No checkout was performed');
    console.error('[real-repo-push] No main touch was performed');
    console.error('[real-repo-push] Human review required before merge');
    process.exit(0);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[real-repo-push] Error: ${message}`);
    console.error('[real-repo-push] No push was performed');
    console.error('[real-repo-push] No merge was performed');
    console.error('[real-repo-push] No checkout was performed');
    console.error('[real-repo-push] No main touch was performed');
    process.exit(1);
  }
}

if (command === 'real-repo-run') {
  let applyStarted = false;
  try {
    if (!taskId) {
      console.error('[real-repo-run] Error: task id is required');
      console.error('[real-repo-run] No merge was performed');
      console.error('[real-repo-run] No checkout was performed');
      console.error('[real-repo-run] No main touch was performed');
      process.exit(1);
    }

    if (process.env.ALLOW_REAL_REPO_APPLY !== 'true') {
      console.error('[real-repo-run] ALLOW_REAL_REPO_APPLY=true is required');
      console.error('[real-repo-run] No merge was performed');
      console.error('[real-repo-run] No checkout was performed');
      console.error('[real-repo-run] No main touch was performed');
      process.exit(1);
    }

    if (process.env.ALLOW_REAL_REPO_COMMIT !== 'true') {
      console.error('[real-repo-run] ALLOW_REAL_REPO_COMMIT=true is required');
      console.error('[real-repo-run] No merge was performed');
      console.error('[real-repo-run] No checkout was performed');
      console.error('[real-repo-run] No main touch was performed');
      process.exit(1);
    }

    if (process.env.ALLOW_REAL_REPO_PUSH !== 'true') {
      console.error('[real-repo-run] ALLOW_REAL_REPO_PUSH=true is required');
      console.error('[real-repo-run] No merge was performed');
      console.error('[real-repo-run] No checkout was performed');
      console.error('[real-repo-run] No main touch was performed');
      process.exit(1);
    }

    const rawProviderText = process.env.REAL_REPO_PROVIDER_RESPONSE?.trim();
    if (!rawProviderText) {
      console.error('[real-repo-run] Error: REAL_REPO_PROVIDER_RESPONSE env var is required');
      console.error('[real-repo-run] No merge was performed');
      console.error('[real-repo-run] No checkout was performed');
      console.error('[real-repo-run] No main touch was performed');
      process.exit(1);
    }

    const task = loadTask(getTasksFilePath(), taskId);
    const kimiOutput = parseKimiOutputJson(rawProviderText);
    const updatePaths = kimiOutput.files.map((f) => f.path);

    const guardrailsResult = validateFileList(updatePaths, task.guardrails);
    if (!guardrailsResult.ok) {
      console.error(`[real-repo-run] Guardrails failed: ${guardrailsResult.reason}`);
      console.error('[real-repo-run] No merge was performed');
      console.error('[real-repo-run] No checkout was performed');
      console.error('[real-repo-run] No main touch was performed');
      process.exit(1);
    }

    if (task.guardrails.max_lines_changed !== undefined) {
      try {
        validateProposedFileLineDeltas(
          task.repo_path,
          kimiOutput.files,
          task.guardrails.max_lines_changed
        );
      } catch (deltaErr) {
        const deltaMessage = deltaErr instanceof Error ? deltaErr.message : String(deltaErr);
        console.error(`[real-repo-run] Guardrails failed: ${deltaMessage}`);
        console.error('[real-repo-run] No apply was performed');
        console.error('[real-repo-run] No commit was made');
        console.error('[real-repo-run] No push was performed');
        console.error('[real-repo-run] No merge was performed');
        console.error('[real-repo-run] No checkout was performed');
        console.error('[real-repo-run] No main touch was performed');
        process.exit(1);
      }
    }

    let currentBranch = '';
    let isClean = false;
    try {
      ensureClean(task.repo_path);
      isClean = true;
    } catch {
      isClean = false;
    }

    try {
      currentBranch = getCurrentBranch(task.repo_path);
    } catch {
      currentBranch = '';
    }

    const safetyResult = validateRealRepoApplySafety(task, { isClean, currentBranch });
    if (!safetyResult.ok) {
      console.error(`[real-repo-run] Safety check failed: ${safetyResult.reason}`);
      console.error('[real-repo-run] No merge was performed');
      console.error('[real-repo-run] No checkout was performed');
      console.error('[real-repo-run] No main touch was performed');
      process.exit(1);
    }

    // Sandbox preflight gate
    const sandboxRootRun = mkdtempSync(join(tmpdir(), 'preflight-'));
    try {
      const preflightResult = runRealRepoSandboxPreflight({
        task,
        rawProviderText,
        sandboxRoot: sandboxRootRun,
      });
      if (!preflightResult.ok) {
        console.error(`[real-repo-run] Sandbox preflight failed at step: ${preflightResult.failedStep}`);
        const summary = redactSecrets(preflightResult.logs).split('\n').slice(-5).join('\n');
        console.error(`[real-repo-run] Sandbox logs (last 5 lines):\n${summary}`);
        console.error('[real-repo-run] No apply was performed');
        console.error('[real-repo-run] No commit was made');
        console.error('[real-repo-run] No push was performed');
        console.error('[real-repo-run] No merge was performed');
        process.exit(1);
      }
    } finally {
      if (existsSync(sandboxRootRun)) {
        rmSync(sandboxRootRun, { recursive: true, force: true });
      }
    }

    const existingPaths: string[] = [];
    for (const f of kimiOutput.files) {
      const filePath = join(task.repo_path, f.path);
      if (existsSync(filePath)) {
        existingPaths.push(f.path);
      }
    }

    const planResult = buildRealRepoApplyPlan({
      taskId,
      attempt: 1,
      existingPaths,
      files: kimiOutput.files,
    });

    if (!planResult.ok) {
      console.error(`[real-repo-run] Plan builder failed: ${planResult.reason}`);
      for (const msg of planResult.safetyMessages) {
        console.error(`[real-repo-run] ${msg}`);
      }
      console.error('[real-repo-run] No merge was performed');
      console.error('[real-repo-run] No checkout was performed');
      console.error('[real-repo-run] No main touch was performed');
      process.exit(1);
    }

    let manifest: import('./types.js').PatchManifestEntry[] | undefined;
    try {
      applyStarted = true;
      manifest = applyFileUpdates(task.repo_path, kimiOutput.files, planResult.runDir);
    } catch (applyErr) {
      const applyMessage = applyErr instanceof Error ? applyErr.message : String(applyErr);
      console.error(`[real-repo-run] Apply failed: ${applyMessage}`);
      console.error('[real-repo-run] Manual inspection required');
      console.error('[real-repo-run] No merge was performed');
      console.error('[real-repo-run] No checkout was performed');
      console.error('[real-repo-run] No main touch was performed');
      process.exit(1);
    }

    const checkResult = runChecks(task.repo_path, task.checks);
    if (!checkResult.success) {
      console.error('[real-repo-run] Checks failed');
      if (manifest && manifest.length > 0) {
        try {
          rollbackFileUpdates(task.repo_path, manifest);
          console.error('[real-repo-run] Rollback completed');
        } catch (rollbackErr) {
          const rollbackMessage = rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr);
          console.error(`[real-repo-run] Rollback failed: ${rollbackMessage}`);
        }
      } else {
        console.error('[real-repo-run] Rollback could not be attempted because apply manifest was not returned');
      }
      console.error('[real-repo-run] No merge was performed');
      console.error('[real-repo-run] No checkout was performed');
      console.error('[real-repo-run] No main touch was performed');
      process.exit(1);
    }

    // Validate working tree contains only approved changes before commit
    const approvedPaths = new Set(updatePaths);
    const { all: allChanges } = getRepoWorkingTreeChanges(task.repo_path);
    const unrelated = allChanges.filter((p) => !approvedPaths.has(p));
    if (unrelated.length > 0) {
      console.error(`[real-repo-run] Unrelated changes detected: ${unrelated.join(', ')}`);
      if (manifest && manifest.length > 0) {
        try {
          rollbackFileUpdates(task.repo_path, manifest);
          console.error('[real-repo-run] Rollback completed');
        } catch (rollbackErr) {
          const rollbackMessage = rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr);
          console.error(`[real-repo-run] Rollback failed: ${rollbackMessage}`);
        }
      }
      console.error('[real-repo-run] No commit was made');
      console.error('[real-repo-run] No push was performed');
      console.error('[real-repo-run] No merge was performed');
      console.error('[real-repo-run] No checkout was performed');
      console.error('[real-repo-run] No main touch was performed');
      process.exit(1);
    }

    if (allChanges.length === 0) {
      console.error('[real-repo-run] No working tree changes match the approved apply manifest');
      console.error('[real-repo-run] No commit was made');
      console.error('[real-repo-run] No push was performed');
      console.error('[real-repo-run] No merge was performed');
      console.error('[real-repo-run] No checkout was performed');
      console.error('[real-repo-run] No main touch was performed');
      process.exit(1);
    }

    // Stage approved files
    const approvedChanged = allChanges.filter((p) => approvedPaths.has(p));
    for (const p of approvedChanged) {
      const addResult = spawnSync('git', ['add', p], {
        cwd: task.repo_path,
        shell: false,
        encoding: 'utf-8',
      });
      if (addResult.status !== 0) {
        console.error('[real-repo-run] Git add failed');
        console.error('[real-repo-run] No commit was made');
        console.error('[real-repo-run] No push was performed');
        console.error('[real-repo-run] No merge was performed');
        console.error('[real-repo-run] No checkout was performed');
        console.error('[real-repo-run] No main touch was performed');
        process.exit(1);
      }
    }

    // Commit
    const commitMessage = `ai-orchestrator: apply ${taskId}`;
    const commitResult = spawnSync('git', ['commit', '-m', commitMessage, '--no-gpg-sign'], {
      cwd: task.repo_path,
      shell: false,
      encoding: 'utf-8',
    });
    if (commitResult.status !== 0) {
      console.error('[real-repo-run] Git commit failed');
      console.error('[real-repo-run] Manual inspection required');
      console.error('[real-repo-run] No push was performed');
      console.error('[real-repo-run] No merge was performed');
      console.error('[real-repo-run] No checkout was performed');
      console.error('[real-repo-run] No main touch was performed');
      process.exit(1);
    }

    // Push
    const pushResult = spawnSync('git', ['push', 'origin', currentBranch], {
      cwd: task.repo_path,
      shell: false,
      encoding: 'utf-8',
    });
    if (pushResult.status !== 0) {
      console.error('[real-repo-run] Git push failed');
      console.error('[real-repo-run] Manual inspection required');
      console.error('[real-repo-run] No merge was performed');
      console.error('[real-repo-run] No checkout was performed');
      console.error('[real-repo-run] No main touch was performed');
      process.exit(1);
    }

    // Write state
    const headResult = spawnSync('git', ['rev-parse', '--verify', 'HEAD'], {
      cwd: task.repo_path,
      shell: false,
      encoding: 'utf-8',
    });
    const headSha = headResult.status === 0 ? headResult.stdout.trim() : '';
    const now = new Date().toISOString();
    let existingState: RunState | null = null;
    try {
      existingState = loadState(taskId);
    } catch {
      // ignore
    }
    const pushState: RunState = {
      task_id: taskId,
      status: 'pushed',
      current_attempt: existingState?.current_attempt ?? 0,
      branch: currentBranch,
      repo_path: task.repo_path,
      created_at: existingState?.created_at ?? now,
      updated_at: now,
      pushed_remote: 'origin',
      pushed_ref: currentBranch,
      commit_sha: headSha,
      safety_note: 'Push completed; merge not performed; human review required before merge',
    };

    try {
      saveState(taskId, pushState);
    } catch (stateErr) {
      console.error('[real-repo-run] Push completed');
      console.error('[real-repo-run] State write failed');
      console.error('[real-repo-run] Manual inspection required');
      console.error('[real-repo-run] No merge was performed');
      console.error('[real-repo-run] No checkout was performed');
      console.error('[real-repo-run] No main touch was performed');
      process.exit(1);
    }

    console.error('[real-repo-run] Real repo run completed');
    console.error(`[real-repo-run] Applied files: ${kimiOutput.files.length}`);
    console.error('[real-repo-run] Commit created');
    console.error('[real-repo-run] Push completed');
    console.error('[real-repo-run] State written');
    console.error('[real-repo-run] Human review required before merge');
    process.exit(0);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[real-repo-run] Error: ${message}`);
    console.error('[real-repo-run] No merge was performed');
    console.error('[real-repo-run] No checkout was performed');
    console.error('[real-repo-run] No main touch was performed');
    process.exit(1);
  }
}

if (command === 'real-repo-run-ai') {
  let applyStarted = false;
  try {
    if (!taskId) {
      console.error('[real-repo-run-ai] Error: task id is required');
      console.error('[real-repo-run-ai] No provider call was made');
      console.error('[real-repo-run-ai] No apply was performed');
      console.error('[real-repo-run-ai] No commit was made');
      console.error('[real-repo-run-ai] No push was performed');
      console.error('[real-repo-run-ai] No merge was performed');
      console.error('[real-repo-run-ai] No checkout was performed');
      console.error('[real-repo-run-ai] No main touch was performed');
      process.exitCode = 1;
      break commandDispatch;
    }

    const allowRealProvider = process.env.ALLOW_REAL_PROVIDER === 'true' || process.env.ALLOW_REAL_PROVIDER === '1';
    if (!allowRealProvider) {
      console.error('[real-repo-run-ai] ALLOW_REAL_PROVIDER=true or ALLOW_REAL_PROVIDER=1 is required');
      console.error('[real-repo-run-ai] No provider call was made');
      console.error('[real-repo-run-ai] No apply was performed');
      console.error('[real-repo-run-ai] No commit was made');
      console.error('[real-repo-run-ai] No push was performed');
      console.error('[real-repo-run-ai] No merge was performed');
      console.error('[real-repo-run-ai] No checkout was performed');
      console.error('[real-repo-run-ai] No main touch was performed');
      process.exitCode = 1;
      break commandDispatch;
    }

    if (process.env.ALLOW_REAL_REPO_APPLY !== 'true') {
      console.error('[real-repo-run-ai] ALLOW_REAL_REPO_APPLY=true is required');
      console.error('[real-repo-run-ai] No provider call was made');
      console.error('[real-repo-run-ai] No apply was performed');
      console.error('[real-repo-run-ai] No commit was made');
      console.error('[real-repo-run-ai] No push was performed');
      console.error('[real-repo-run-ai] No merge was performed');
      console.error('[real-repo-run-ai] No checkout was performed');
      console.error('[real-repo-run-ai] No main touch was performed');
      process.exitCode = 1;
      break commandDispatch;
    }

    if (process.env.ALLOW_REAL_REPO_COMMIT !== 'true') {
      console.error('[real-repo-run-ai] ALLOW_REAL_REPO_COMMIT=true is required');
      console.error('[real-repo-run-ai] No provider call was made');
      console.error('[real-repo-run-ai] No apply was performed');
      console.error('[real-repo-run-ai] No commit was made');
      console.error('[real-repo-run-ai] No push was performed');
      console.error('[real-repo-run-ai] No merge was performed');
      console.error('[real-repo-run-ai] No checkout was performed');
      console.error('[real-repo-run-ai] No main touch was performed');
      process.exitCode = 1;
      break commandDispatch;
    }

    if (process.env.ALLOW_REAL_REPO_PUSH !== 'true') {
      console.error('[real-repo-run-ai] ALLOW_REAL_REPO_PUSH=true is required');
      console.error('[real-repo-run-ai] No provider call was made');
      console.error('[real-repo-run-ai] No apply was performed');
      console.error('[real-repo-run-ai] No commit was made');
      console.error('[real-repo-run-ai] No push was performed');
      console.error('[real-repo-run-ai] No merge was performed');
      console.error('[real-repo-run-ai] No checkout was performed');
      console.error('[real-repo-run-ai] No main touch was performed');
      process.exitCode = 1;
      break commandDispatch;
    }

    const task = loadTask(getTasksFilePath(), taskId);

    let currentBranch = '';
    let isClean = false;
    try {
      ensureClean(task.repo_path);
      isClean = true;
    } catch {
      isClean = false;
    }

    try {
      currentBranch = getCurrentBranch(task.repo_path);
    } catch {
      currentBranch = '';
    }

    const safetyResult = validateRealRepoApplySafety(task, { isClean, currentBranch });
    if (!safetyResult.ok) {
      console.error(`[real-repo-run-ai] Safety check failed: ${safetyResult.reason}`);
      console.error('[real-repo-run-ai] No provider call was made');
      console.error('[real-repo-run-ai] No apply was performed');
      console.error('[real-repo-run-ai] No commit was made');
      console.error('[real-repo-run-ai] No push was performed');
      console.error('[real-repo-run-ai] No merge was performed');
      console.error('[real-repo-run-ai] No checkout was performed');
      console.error('[real-repo-run-ai] No main touch was performed');
      process.exitCode = 1;
      break commandDispatch;
    }

    let maxAttempts: number;
    try {
      maxAttempts = validateMaxAttempts(process.env.REAL_REPO_AI_MAX_ATTEMPTS);
    } catch (maxErr) {
      const maxMessage = maxErr instanceof Error ? maxErr.message : String(maxErr);
      console.error(`[real-repo-run-ai] ${maxMessage}`);
      console.error('[real-repo-run-ai] No provider call was made');
      console.error('[real-repo-run-ai] No apply was performed');
      console.error('[real-repo-run-ai] No commit was made');
      console.error('[real-repo-run-ai] No push was performed');
      console.error('[real-repo-run-ai] No merge was performed');
      console.error('[real-repo-run-ai] No checkout was performed');
      console.error('[real-repo-run-ai] No main touch was performed');
      process.exitCode = 1;
      break commandDispatch;
    }

    const apiKey = process.env.KIMI_API_KEY?.trim();
    if (!apiKey) {
      console.error('[real-repo-run-ai] Error: KIMI_API_KEY env var is required');
      console.error('[real-repo-run-ai] No provider call was made');
      console.error('[real-repo-run-ai] No apply was performed');
      console.error('[real-repo-run-ai] No commit was made');
      console.error('[real-repo-run-ai] No push was performed');
      console.error('[real-repo-run-ai] No merge was performed');
      console.error('[real-repo-run-ai] No checkout was performed');
      console.error('[real-repo-run-ai] No main touch was performed');
      process.exitCode = 1;
      break commandDispatch;
    }

    const baseUrl = process.env.KIMI_BASE_URL?.trim();
    if (!baseUrl) {
      console.error('[real-repo-run-ai] Error: KIMI_BASE_URL env var is required');
      console.error('[real-repo-run-ai] No provider call was made');
      console.error('[real-repo-run-ai] No apply was performed');
      console.error('[real-repo-run-ai] No commit was made');
      console.error('[real-repo-run-ai] No push was performed');
      console.error('[real-repo-run-ai] No merge was performed');
      console.error('[real-repo-run-ai] No checkout was performed');
      console.error('[real-repo-run-ai] No main touch was performed');
      process.exitCode = 1;
      break commandDispatch;
    }

    const model = process.env.KIMI_MODEL?.trim() || 'kimi-k2.6';
    const userAgent = process.env.KIMI_USER_AGENT?.trim();

    const fakeResponse = process.env.KIMI_FAKE_RESPONSE;
    const fakeResponsesRaw = process.env.KIMI_FAKE_RESPONSES;
    let fetchFn: FetchFn;
    let fakeResponseIndex = 0;
    if (fakeResponsesRaw !== undefined) {
      let fakeResponses: string[];
      try {
        const parsed = JSON.parse(fakeResponsesRaw);
        fakeResponses = Array.isArray(parsed) ? parsed : [];
      } catch {
        fakeResponses = [];
      }
      fetchFn = async () => {
        const content = fakeResponses[fakeResponseIndex] ?? '';
        fakeResponseIndex++;
        if (content === '__FETCH_ERROR__') {
          return { ok: false, status: 500, json: async () => ({}) };
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({
            choices: [{ message: { content } }],
          }),
        };
      };
    } else if (fakeResponse !== undefined) {
      fetchFn = async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: { content: fakeResponse } }],
        }),
      });
    } else {
      if (typeof globalThis.fetch !== 'function') {
        console.error('[real-repo-run-ai] Error: global fetch is not available');
        console.error('[real-repo-run-ai] No provider call was made');
        console.error('[real-repo-run-ai] No apply was performed');
        console.error('[real-repo-run-ai] No commit was made');
        console.error('[real-repo-run-ai] No push was performed');
        console.error('[real-repo-run-ai] No merge was performed');
        console.error('[real-repo-run-ai] No checkout was performed');
        console.error('[real-repo-run-ai] No main touch was performed');
        process.exitCode = 1;
        break commandDispatch;
      }
      fetchFn = globalThis.fetch as unknown as FetchFn;
    }

    const context = buildContext(task);
    const basePrompt = buildKimiPrompt(context);

    let lastKimiOutput: KimiOutput | undefined;
    let lastManifest: import('./types.js').PatchManifestEntry[] | undefined;
    let lastCheckResult: import('./types.js').RunResult | undefined;
    let repairSucceeded = false;
    let finalKimiOutput: KimiOutput | undefined;
    let repairPrompt: string | undefined;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const isRepair = attempt > 1;
      const currentPrompt = repairPrompt ?? (isRepair && lastCheckResult && lastKimiOutput
        ? buildRepairPrompt(task, currentBranch, lastCheckResult, lastKimiOutput.files)
        : basePrompt);

      if (isRepair) {
        if (repairPrompt) {
          console.error(`[real-repo-run-ai] Repair attempt ${attempt}/${maxAttempts} (sandbox preflight)`);
        } else {
          console.error(`[real-repo-run-ai] Repair attempt ${attempt}/${maxAttempts}`);
        }
      }

      let kimiOutput: KimiOutput;
      let rawProviderText: string;
      try {
        const realProviderCall = createRealProviderCall({
          provider: 'kimi',
          apiKey,
          baseUrl,
          fetchFn,
          model,
          userAgent: process.env.KIMI_USER_AGENT?.trim(),
        });
        const providerInput = buildProviderCallInput('coder', currentPrompt, 'kimi', model);
        const result = await realProviderCall(providerInput);
        const normalizedResult = normalizeProviderCallResult(result);
        rawProviderText = normalizedResult.text;
        kimiOutput = parseKimiOutputJson(rawProviderText);
      } catch (providerErr) {
        const info = normalizeProviderCallError(providerErr);
        const message = info.message;
        const isParseError = message.includes('Invalid Kimi JSON') || message.includes('KimiOutput') || message.includes('JSON');
        if (isRepair) {
          if (isParseError) {
            console.error(`[real-repo-run-ai] Provider repair output malformed: ${message}`);
          } else {
            console.error(`[real-repo-run-ai] Provider repair call failed: ${message}`);
          }
        } else {
          if (isParseError) {
            console.error(`[real-repo-run-ai] Provider output malformed: ${message}`);
          } else {
            console.error(`[real-repo-run-ai] Provider call failed: ${message}`);
          }
        }
        console.error('[real-repo-run-ai] Manual inspection required');
        console.error('[real-repo-run-ai] No apply was performed');
        console.error('[real-repo-run-ai] No commit was made');
        console.error('[real-repo-run-ai] No push was performed');
        console.error('[real-repo-run-ai] No merge was performed');
        console.error('[real-repo-run-ai] No checkout was performed');
        console.error('[real-repo-run-ai] No main touch was performed');
        process.exitCode = 1;
        break commandDispatch;
      }

      const updatePaths = kimiOutput.files.map((f) => f.path);

      const guardrailsResult = validateFileList(updatePaths, task.guardrails);
      if (!guardrailsResult.ok) {
        console.error(`[real-repo-run-ai] Guardrails failed: ${guardrailsResult.reason}`);
        console.error('[real-repo-run-ai] No apply was performed');
        console.error('[real-repo-run-ai] No commit was made');
        console.error('[real-repo-run-ai] No push was performed');
        console.error('[real-repo-run-ai] No merge was performed');
        console.error('[real-repo-run-ai] No checkout was performed');
        console.error('[real-repo-run-ai] No main touch was performed');
        process.exitCode = 1;
        break commandDispatch;
      }

      if (task.guardrails.max_lines_changed !== undefined) {
        try {
          validateProposedFileLineDeltas(
            task.repo_path,
            kimiOutput.files,
            task.guardrails.max_lines_changed
          );
        } catch (deltaErr) {
          const deltaMessage = deltaErr instanceof Error ? deltaErr.message : String(deltaErr);
          console.error(`[real-repo-run-ai] Guardrails failed: ${deltaMessage}`);
          console.error('[real-repo-run-ai] No apply was performed');
          console.error('[real-repo-run-ai] No commit was made');
          console.error('[real-repo-run-ai] No push was performed');
          console.error('[real-repo-run-ai] No merge was performed');
          console.error('[real-repo-run-ai] No checkout was performed');
          console.error('[real-repo-run-ai] No main touch was performed');
          process.exitCode = 1;
          break commandDispatch;
        }
      }

      // Sandbox preflight gate
      const sandboxRootAi = mkdtempSync(join(tmpdir(), 'preflight-'));
      try {
        const preflightResult = runRealRepoSandboxPreflight({
          task,
          rawProviderText,
          sandboxRoot: sandboxRootAi,
        });
        if (!preflightResult.ok) {
          const repairDecision = buildSandboxPreflightRepairDecision({
            failedStep: preflightResult.failedStep ?? 'unknown',
            logs: preflightResult.logs,
            attempt,
            maxAttempts,
            taskGoal: task.goal,
            rawProviderText,
          });

          if (repairDecision.repairable && repairDecision.repairPrompt) {
            console.error(`[real-repo-run-ai] Sandbox checks failed on attempt ${attempt}, requesting repair...`);
            repairPrompt = repairDecision.repairPrompt;
            continue;
          }

          console.error(`[real-repo-run-ai] Sandbox preflight failed at step: ${preflightResult.failedStep}`);
          console.error(`[real-repo-run-ai] ${repairDecision.reason}`);
          const summary = redactSecrets(preflightResult.logs).split('\n').slice(-5).join('\n');
          console.error(`[real-repo-run-ai] Sandbox logs (last 5 lines):\n${summary}`);
          console.error('[real-repo-run-ai] No apply was performed');
          console.error('[real-repo-run-ai] No commit was made');
          console.error('[real-repo-run-ai] No push was performed');
          console.error('[real-repo-run-ai] No merge was performed');
          console.error('[real-repo-run-ai] No checkout was performed');
          console.error('[real-repo-run-ai] No main touch was performed');
          process.exitCode = 1;
          break commandDispatch;
        }
      } finally {
        if (existsSync(sandboxRootAi)) {
          rmSync(sandboxRootAi, { recursive: true, force: true });
        }
      }

      // Sandbox preflight passed; reset repair prompt for any downstream repairs
      repairPrompt = undefined;

      const existingPaths: string[] = [];
      for (const f of kimiOutput.files) {
        const filePath = join(task.repo_path, f.path);
        if (existsSync(filePath)) {
          existingPaths.push(f.path);
        }
      }

      const planResult = buildRealRepoApplyPlan({
        taskId,
        attempt,
        existingPaths,
        files: kimiOutput.files,
      });

      if (!planResult.ok) {
        console.error(`[real-repo-run-ai] Plan builder failed: ${planResult.reason}`);
        for (const msg of planResult.safetyMessages) {
          console.error(`[real-repo-run-ai] ${msg}`);
        }
        console.error('[real-repo-run-ai] No merge was performed');
        console.error('[real-repo-run-ai] No checkout was performed');
        console.error('[real-repo-run-ai] No main touch was performed');
        process.exitCode = 1;
        break commandDispatch;
      }

      let manifest: import('./types.js').PatchManifestEntry[] | undefined;
      try {
        applyStarted = true;
        manifest = applyFileUpdates(task.repo_path, kimiOutput.files, planResult.runDir);
      } catch (applyErr) {
        const applyMessage = applyErr instanceof Error ? applyErr.message : String(applyErr);
        console.error(`[real-repo-run-ai] Apply failed: ${applyMessage}`);
        console.error('[real-repo-run-ai] Manual inspection required');
        console.error('[real-repo-run-ai] No merge was performed');
        console.error('[real-repo-run-ai] No checkout was performed');
        console.error('[real-repo-run-ai] No main touch was performed');
        process.exitCode = 1;
        break commandDispatch;
      }

      const checkResult = runChecks(task.repo_path, task.checks);
      lastCheckResult = checkResult;
      if (!checkResult.success) {
        if (manifest && manifest.length > 0) {
          try {
            rollbackFileUpdates(task.repo_path, manifest);
            console.error('[real-repo-run-ai] Rollback completed');
          } catch (rollbackErr) {
            const rollbackMessage = rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr);
            console.error(`[real-repo-run-ai] Rollback failed: ${rollbackMessage}`);
          }
        } else {
          console.error('[real-repo-run-ai] Rollback could not be attempted because apply manifest was not returned');
        }

        if (attempt < maxAttempts) {
          lastKimiOutput = kimiOutput;
          lastManifest = manifest;
          lastCheckResult = checkResult;
          console.error(`[real-repo-run-ai] Checks failed on attempt ${attempt}, retrying...`);
          continue;
        }

        console.error(`[real-repo-run-ai] Checks failed after ${attempt} attempt(s)`);
        console.error('[real-repo-run-ai] No commit was made');
        console.error('[real-repo-run-ai] No push was performed');
        console.error('[real-repo-run-ai] No state write was performed');
        console.error('[real-repo-run-ai] Manual inspection required');
        console.error('[real-repo-run-ai] No merge was performed');
        console.error('[real-repo-run-ai] No checkout was performed');
        console.error('[real-repo-run-ai] No main touch was performed');
        process.exitCode = 1;
        break commandDispatch;
      }

      const approvedPaths = new Set(updatePaths);
      const { all: allChanges } = getRepoWorkingTreeChanges(task.repo_path);
      const unrelated = allChanges.filter((p) => !approvedPaths.has(p));
      if (unrelated.length > 0) {
        console.error(`[real-repo-run-ai] Unrelated changes detected: ${unrelated.join(', ')}`);
        if (manifest && manifest.length > 0) {
          try {
            rollbackFileUpdates(task.repo_path, manifest);
            console.error('[real-repo-run-ai] Rollback completed');
          } catch (rollbackErr) {
            const rollbackMessage = rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr);
            console.error(`[real-repo-run-ai] Rollback failed: ${rollbackMessage}`);
          }
        }
        console.error('[real-repo-run-ai] No commit was made');
        console.error('[real-repo-run-ai] No push was performed');
        console.error('[real-repo-run-ai] No merge was performed');
        console.error('[real-repo-run-ai] No checkout was performed');
        console.error('[real-repo-run-ai] No main touch was performed');
        process.exitCode = 1;
        break commandDispatch;
      }

      if (allChanges.length === 0) {
        console.error('[real-repo-run-ai] No working tree changes match the approved apply manifest');
        console.error('[real-repo-run-ai] No commit was made');
        console.error('[real-repo-run-ai] No push was performed');
        console.error('[real-repo-run-ai] No merge was performed');
        console.error('[real-repo-run-ai] No checkout was performed');
        console.error('[real-repo-run-ai] No main touch was performed');
        process.exitCode = 1;
        break commandDispatch;
      }

      const approvedChanged = allChanges.filter((p) => approvedPaths.has(p));
      for (const p of approvedChanged) {
        const addResult = spawnSync('git', ['add', p], {
          cwd: task.repo_path,
          shell: false,
          encoding: 'utf-8',
        });
        if (addResult.status !== 0) {
          console.error('[real-repo-run-ai] Git add failed');
          console.error('[real-repo-run-ai] No commit was made');
          console.error('[real-repo-run-ai] No push was performed');
          console.error('[real-repo-run-ai] No merge was performed');
          console.error('[real-repo-run-ai] No checkout was performed');
          console.error('[real-repo-run-ai] No main touch was performed');
          process.exitCode = 1;
          break commandDispatch;
        }
      }

      const commitMessage = `ai-orchestrator: apply ${taskId}`;
      const commitResult = spawnSync('git', ['commit', '-m', commitMessage, '--no-gpg-sign'], {
        cwd: task.repo_path,
        shell: false,
        encoding: 'utf-8',
      });
      if (commitResult.status !== 0) {
        console.error('[real-repo-run-ai] Git commit failed');
        console.error('[real-repo-run-ai] Manual inspection required');
        console.error('[real-repo-run-ai] No push was performed');
        console.error('[real-repo-run-ai] No merge was performed');
        console.error('[real-repo-run-ai] No checkout was performed');
        console.error('[real-repo-run-ai] No main touch was performed');
        process.exitCode = 1;
        break commandDispatch;
      }

      const pushResult = spawnSync('git', ['push', 'origin', currentBranch], {
        cwd: task.repo_path,
        shell: false,
        encoding: 'utf-8',
      });
      if (pushResult.status !== 0) {
        console.error('[real-repo-run-ai] Git push failed');
        console.error('[real-repo-run-ai] Manual inspection required');
        console.error('[real-repo-run-ai] No merge was performed');
        console.error('[real-repo-run-ai] No checkout was performed');
        console.error('[real-repo-run-ai] No main touch was performed');
        process.exitCode = 1;
        break commandDispatch;
      }

      const headResult = spawnSync('git', ['rev-parse', '--verify', 'HEAD'], {
        cwd: task.repo_path,
        shell: false,
        encoding: 'utf-8',
      });
      const headSha = headResult.status === 0 ? headResult.stdout.trim() : '';
      const now = new Date().toISOString();
      let existingState: RunState | null = null;
      try {
        existingState = loadState(taskId);
      } catch {
        // ignore
      }
      const pushState: RunState = {
        task_id: taskId,
        status: 'pushed',
        current_attempt: existingState?.current_attempt ?? 0,
        branch: currentBranch,
        repo_path: task.repo_path,
        created_at: existingState?.created_at ?? now,
        updated_at: now,
        pushed_remote: 'origin',
        pushed_ref: currentBranch,
        commit_sha: headSha,
        safety_note: 'Push completed; merge not performed; human review required before merge',
      };

      try {
        saveState(taskId, pushState);
      } catch (stateErr) {
        console.error('[real-repo-run-ai] Push completed');
        console.error('[real-repo-run-ai] State write failed');
        console.error('[real-repo-run-ai] Manual inspection required');
        console.error('[real-repo-run-ai] No merge was performed');
        console.error('[real-repo-run-ai] No checkout was performed');
        console.error('[real-repo-run-ai] No main touch was performed');
        process.exitCode = 1;
        break commandDispatch;
      }

      // Reviewer gate (fake or real Kimi)
      const fakeReviewerResponse = process.env.REAL_REPO_REVIEWER_FAKE_RESPONSE;
      const allowRealProvider =
        process.env.ALLOW_REAL_PROVIDER === 'true' || process.env.ALLOW_REAL_PROVIDER === '1';
      if (fakeReviewerResponse || allowRealProvider) {
        let reviewerGatePersisted:
          | {
              status: ReviewerGateStatus;
              source: ReviewerGateDecisionSource;
              nextAction: 'continue' | 'fix' | 'block';
              blockingIssues: string[];
              nonBlockingIssues: string[];
              reviewSummary: string;
              fixTask?: string;
            }
          | undefined;
        try {
          const reviewerResult = await runCommittedTaskReviewerGate({
            repoPath: task.repo_path,
            taskId,
            taskGoal: task.goal,
            branchName: currentBranch,
            commitSha: headSha,
            checkSummary: {
              test: lastCheckResult?.success ? 'pass' : (lastCheckResult ? 'fail' : undefined),
            },
            stateStatus: 'pushed',
            reviewer: async (input) => {
              const captureFile = process.env.REAL_REPO_REVIEWER_CAPTURE_INPUT_FILE;
              if (captureFile) {
                writeFileSync(captureFile, JSON.stringify(input, null, 2), 'utf-8');
              }
              if (process.env.REAL_REPO_REVIEWER_FORCE_PROVIDER_ERROR === 'true') {
                throw new Error('Forced reviewer provider error for testing.');
              }
              if (fakeReviewerResponse) {
                return fakeReviewerResponse;
              }

              const reviewerProvider = createKimiReviewerProvider(
                { provider: 'kimi', apiKey, baseUrl, model, userAgent },
                {
                  allowReal: true,
                  fakeResponse: process.env.KIMI_FAKE_REVIEWER_RESPONSE,
                  fetchFn: globalThis.fetch as unknown as FetchFn,
                }
              );
              const diffResult = spawnSync('git', ['show', '--format=', '-p', headSha], {
                cwd: task.repo_path,
                shell: false,
                encoding: 'utf-8',
              });
              const diff = diffResult.status === 0 ? diffResult.stdout : '';
              const gitStatusResult = spawnSync('git', ['status', '--short'], {
                cwd: task.repo_path,
                shell: false,
                encoding: 'utf-8',
              });
              const gitStatus = gitStatusResult.status === 0 ? gitStatusResult.stdout : '';
              const providerInput = buildReviewInput({
                taskId,
                taskTitle: task.title,
                taskGoal: task.goal,
                allowedFiles: task.guardrails.allow_modify ?? [],
                deniedFiles: task.guardrails.deny_modify,
                maxLinesChanged: task.guardrails.max_lines_changed ?? Number.MAX_SAFE_INTEGER,
                commitSha: headSha,
                changedFiles: input.changedFiles,
                diff,
                typecheckResult: input.checkSummary.typecheck ?? 'pass',
                buildResult: input.checkSummary.build ?? 'pass',
                testResult: input.checkSummary.test ?? (lastCheckResult?.success ? 'pass' : 'fail'),
                gitStatus,
                safetyFindings: [],
              });
              const decision = await reviewerProvider.reviewCommit(providerInput);
              const nextAction = decision.next_action;
              const mappedDecision =
                nextAction === 'advance_to_next_task'
                  ? 'accept'
                  : nextAction === 'send_fix_to_coder'
                    ? 'reject'
                    : 'block_for_human';
              const mappedNextAction =
                nextAction === 'advance_to_next_task'
                  ? 'continue'
                  : nextAction === 'send_fix_to_coder'
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
          });
          const gate = reviewerResult.reviewerRunnerResult.gateResult;
          reviewerGatePersisted = {
            status: gate.status,
            source: gate.source,
            nextAction: gate.nextAction,
            blockingIssues: gate.blockingIssues.map((i) => redactSecrets(i)),
            nonBlockingIssues: gate.nonBlockingIssues.map((i) => redactSecrets(i)),
            reviewSummary: redactSecrets(gate.reviewSummary),
            fixTask: gate.fixTask ? redactSecrets(gate.fixTask) : undefined,
          };
          if (gate.status === 'accepted') {
            console.error('[real-repo-run-ai] Reviewer gate accepted');
          } else {
            const issues = redactSecrets(gate.blockingIssues.join('; '));
            if (gate.status === 'fix_required') {
              console.error('[real-repo-run-ai] Reviewer gate fix_required');
              if (issues) console.error(`[real-repo-run-ai] Blocking issues: ${issues}`);
              if (gate.fixTask) console.error(`[real-repo-run-ai] Fix task: ${redactSecrets(gate.fixTask)}`);
            } else {
              console.error('[real-repo-run-ai] Reviewer gate blocked');
              if (issues) console.error(`[real-repo-run-ai] Blocking issues: ${issues}`);
            }
          }
        } catch (reviewerErr) {
          const msg = reviewerErr instanceof Error ? reviewerErr.message : String(reviewerErr);
          console.error(`[real-repo-run-ai] Reviewer gate error: ${redactSecrets(msg)}`);
          reviewerGatePersisted = {
            status: 'blocked',
            source: 'provider',
            nextAction: 'block',
            blockingIssues: [redactSecrets(msg)],
            nonBlockingIssues: [],
            reviewSummary: redactSecrets('Reviewer gate unexpected error.'),
          };
        }
        if (reviewerGatePersisted) {
          const stateWithGate = { ...pushState };
          (stateWithGate as Record<string, unknown>).reviewer_gate = reviewerGatePersisted;
          const reviewResult = deriveReviewerBlockReviewResult({
            blockId: `single-task-review:${taskId}`,
            tasks: [
              {
                taskId,
                taskTitle: task.title,
                taskGoal: task.goal,
                runState: stateWithGate,
              },
            ],
            existingFixAttemptsByParentTaskId: {},
            maxFixAttempts: 1,
          });
          (stateWithGate as Record<string, unknown>).reviewer_block_review_result = reviewResult;
          const resolutionPlan = reviewResult.resolutionPlan;
          if (
            resolutionPlan.action === 'append_fix_task' &&
            resolutionPlan.fixTask
          ) {
            (stateWithGate as Record<string, unknown>).pending_reviewer_fix_task = {
              status: 'pending',
              source: 'reviewer_gate',
              task: resolutionPlan.fixTask,
              parentTaskId: resolutionPlan.fixTask.parentTaskId,
              attempt: resolutionPlan.fixTask.attempt,
              createdFromResolutionAction: 'append_fix_task',
            };
            const pendingFixTaskState = readPendingReviewerFixTaskState({
              runState: stateWithGate,
            });
            (stateWithGate as Record<string, unknown>).pending_reviewer_fix_task_state = pendingFixTaskState;
            const executionPlan = derivePendingReviewerFixTaskExecutionPlan({
              pendingFixTaskState,
            });
            (stateWithGate as Record<string, unknown>).pending_reviewer_fix_task_execution_plan = executionPlan;
            const executionRequest = derivePendingReviewerFixTaskExecutionRequest({
              executionPlan,
            });
            (stateWithGate as Record<string, unknown>).pending_reviewer_fix_task_execution_request = executionRequest;
            const executionRequestState = readPendingReviewerFixTaskExecutionRequestState({
              runState: stateWithGate,
            });
            (stateWithGate as Record<string, unknown>).pending_reviewer_fix_task_execution_request_state = executionRequestState;
            const runPlan = deriveReviewerFixTaskRunPlan({
              executionRequestState,
            });
            (stateWithGate as Record<string, unknown>).reviewer_fix_task_run_plan = runPlan;
            const runPlanState = readReviewerFixTaskRunPlanState({
              runState: stateWithGate,
            });
            (stateWithGate as Record<string, unknown>).reviewer_fix_task_run_plan_state = runPlanState;
            const enableFixLoop = process.env.REAL_REPO_ENABLE_REVIEWER_FIX_LOOP === '1';
            const fakeExecutorResponse = process.env.REAL_REPO_REVIEWER_FIX_TASK_FAKE_EXECUTOR_RESPONSE;
            let controlledRun:
              | import('./reviewer-fix-task-controlled-run.js').ReviewerFixTaskControlledRunResult
              | undefined;

            if (enableFixLoop) {
              const realExecutor = createReviewerFixTaskRealExecutor({
                parentTask: task,
              });
              controlledRun = await runReviewerFixTaskControlled({
                runPlanState,
                executor: realExecutor,
              });
            } else if (fakeExecutorResponse) {
              const fakeExecutor = async () => {
                try {
                  const parsed = JSON.parse(fakeExecutorResponse) as {
                    status: unknown;
                    reason: unknown;
                    commitSha?: string;
                    changedFiles?: string[];
                    blockingIssues?: string[];
                    runState?: unknown;
                  };
                  if (
                    parsed.status === 'completed' ||
                    parsed.status === 'blocked'
                  ) {
                    return {
                      status: parsed.status as 'completed' | 'blocked',
                      reason:
                        typeof parsed.reason === 'string'
                          ? parsed.reason
                          : 'Fake executor response.',
                      commitSha: parsed.commitSha,
                      changedFiles: parsed.changedFiles,
                      blockingIssues: parsed.blockingIssues,
                      runState: parsed.runState,
                    };
                  }
                  return {
                    status: 'blocked' as const,
                    reason: 'Unsupported fake executor status; block for human review.',
                  };
                } catch {
                  return {
                    status: 'blocked' as const,
                    reason: 'Invalid fake executor response JSON; block for human review.',
                  };
                }
              };
              controlledRun = await runReviewerFixTaskControlled({
                runPlanState,
                executor: fakeExecutor,
              });
            }

            if (controlledRun) {
              (stateWithGate as Record<string, unknown>).reviewer_fix_task_controlled_run = {
                runnerResultStatus: controlledRun.runnerResult.status,
                runnerResultNextAction: controlledRun.runnerResult.nextAction,
                persistedState: controlledRun.persistedState,
              };

              const postRunPlan = deriveReviewerFixTaskPostRunReviewPlan({
                persistedRunnerState: controlledRun.persistedState,
              });
              (stateWithGate as Record<string, unknown>).reviewer_fix_task_post_run_review_plan = postRunPlan;

              if (
                postRunPlan.action === 'review_fix_result' &&
                postRunPlan.commitSha
              ) {
                const secondReviewerResponse =
                  process.env.REAL_REPO_REVIEWER_SECOND_FAKE_RESPONSE ?? fakeReviewerResponse;
                let secondReviewPersisted:
                  | {
                      status: ReviewerGateStatus;
                      source: ReviewerGateDecisionSource;
                      nextAction: 'continue' | 'fix' | 'block';
                      blockingIssues: string[];
                      nonBlockingIssues: string[];
                      reviewSummary: string;
                      fixTask?: string;
                    }
                  | undefined;
                let secondReviewError: string | undefined;
                if (secondReviewerResponse) {
                  try {
                    const secondReviewerResult = await runCommittedTaskReviewerGate({
                      repoPath: task.repo_path,
                      taskId: postRunPlan.taskId ?? 'unknown',
                      taskGoal: postRunPlan.fixTask?.goal ?? task.goal,
                      branchName: currentBranch,
                      commitSha: postRunPlan.commitSha,
                      checkSummary: { test: 'pass' },
                      stateStatus: 'fix_review',
                      reviewer: async () => secondReviewerResponse,
                    });
                    const secondGate = secondReviewerResult.reviewerRunnerResult.gateResult;
                    secondReviewPersisted = {
                      status: secondGate.status,
                      source: secondGate.source,
                      nextAction: secondGate.nextAction,
                      blockingIssues: secondGate.blockingIssues.map((i) => redactSecrets(i)),
                      nonBlockingIssues: secondGate.nonBlockingIssues.map((i) => redactSecrets(i)),
                      reviewSummary: redactSecrets(secondGate.reviewSummary),
                      fixTask: secondGate.fixTask ? redactSecrets(secondGate.fixTask) : undefined,
                    };
                  } catch (secondErr) {
                    const msg = secondErr instanceof Error ? secondErr.message : String(secondErr);
                    secondReviewError = redactSecrets(msg);
                    secondReviewPersisted = {
                      status: 'blocked',
                      source: 'provider',
                      nextAction: 'block',
                      blockingIssues: [secondReviewError],
                      nonBlockingIssues: [],
                      reviewSummary: redactSecrets('Second reviewer gate unexpected error.'),
                    };
                  }
                } else {
                  secondReviewError = 'No second reviewer response configured; fix commit requires human review.';
                  secondReviewPersisted = {
                    status: 'blocked',
                    source: 'deterministic_safety',
                    nextAction: 'block',
                    blockingIssues: [secondReviewError],
                    nonBlockingIssues: [],
                    reviewSummary: redactSecrets('Second reviewer gate was not configured.'),
                  };
                }

                let finalStatus: 'accepted' | 'fix_required' | 'blocked';
                let finalNextAction: 'continue' | 'block' | 'manual_followup';
                let finalReason: string;
                if (secondReviewPersisted.status === 'accepted') {
                  finalStatus = 'accepted';
                  finalNextAction = 'continue';
                  finalReason = 'Second reviewer gate accepted the fix commit.';
                } else if (secondReviewPersisted.status === 'fix_required') {
                  finalStatus = 'fix_required';
                  finalNextAction = 'manual_followup';
                  finalReason = 'Second reviewer gate rejected the fix commit; max fix attempts reached for this vertical slice.';
                } else {
                  finalStatus = 'blocked';
                  finalNextAction = 'block';
                  finalReason = secondReviewError
                    ? `Second reviewer gate blocked: ${secondReviewError}`
                    : 'Second reviewer gate blocked the fix commit.';
                }

                const secondReviewRunState = {
                  ...stateWithGate,
                  reviewer_gate: secondReviewPersisted,
                };

                const secondReviewParentTaskId = postRunPlan.parentTaskId ?? taskId;
                const secondReviewBlockResult = deriveReviewerBlockReviewResult({
                  blockId: `single-task-review:${secondReviewParentTaskId}`,
                  tasks: [
                    {
                      taskId: secondReviewParentTaskId,
                      taskTitle: postRunPlan.fixTask?.title ?? task.title,
                      taskGoal: postRunPlan.fixTask?.goal ?? task.goal,
                      runState: secondReviewRunState,
                    },
                  ],
                  existingFixAttemptsByParentTaskId: {
                    [secondReviewParentTaskId]: postRunPlan.attempt ?? 1,
                  },
                  maxFixAttempts: 1,
                });

                (stateWithGate as Record<string, unknown>).reviewer_fix_task_second_review = {
                  fixTaskId: postRunPlan.taskId,
                  parentTaskId: postRunPlan.parentTaskId,
                  attempt: postRunPlan.attempt,
                  fixCommitSha: postRunPlan.commitSha,
                  reviewerGate: secondReviewPersisted,
                  reviewerBlockReviewResult: secondReviewBlockResult,
                  finalStatus,
                  nextAction: finalNextAction,
                  reason: redactSecrets(finalReason),
                };

                try {
                  saveState(taskId, stateWithGate as RunState);
                } catch (stateErr) {
                  console.error('[real-repo-run-ai] Reviewer fix-loop state write failed');
                }

                if (finalStatus === 'accepted') {
                  console.error('[real-repo-run-ai] Reviewer fix-loop completed: fix commit accepted');
                  process.exitCode = 0;
                  break commandDispatch;
                }

                console.error(`[real-repo-run-ai] Reviewer fix-loop stopped: ${finalReason}`);
                process.exitCode = 1;
                break commandDispatch;
              }
            }
          }
          try {
            saveState(taskId, stateWithGate as RunState);
          } catch (stateErr) {
            console.error('[real-repo-run-ai] Reviewer gate state write failed');
          }
          if (reviewerGatePersisted.status !== 'accepted') {
            process.exitCode = 1;
            break commandDispatch;
          }
        }
      }

      repairSucceeded = isRepair;
      finalKimiOutput = kimiOutput;
      break;
    }

    if (repairSucceeded) {
      console.error('[real-repo-run-ai] Repair attempt succeeded');
    }
    console.error('[real-repo-run-ai] Real provider run completed');
    console.error(`[real-repo-run-ai] Applied files: ${finalKimiOutput?.files.length ?? 0}`);
    console.error('[real-repo-run-ai] Commit created');
    console.error('[real-repo-run-ai] Push completed');
    console.error('[real-repo-run-ai] State written');
    console.error('[real-repo-run-ai] Human review required before merge');
    process.exitCode = 0;
    break commandDispatch;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[real-repo-run-ai] Error: ${message}`);
    console.error('[real-repo-run-ai] No merge was performed');
    console.error('[real-repo-run-ai] No checkout was performed');
    console.error('[real-repo-run-ai] No main touch was performed');
    process.exitCode = 1;
    break commandDispatch;
  }
}

if (command === 'real-repo-run-ai-readiness') {
  try {
    if (!taskId) {
      console.error('[real-repo-run-ai-readiness] Error: task id is required');
      console.error('[real-repo-run-ai-readiness] No provider call was made');
      console.error('[real-repo-run-ai-readiness] No apply was performed');
      console.error('[real-repo-run-ai-readiness] No commit was made');
      console.error('[real-repo-run-ai-readiness] No push was performed');
      console.error('[real-repo-run-ai-readiness] No merge was performed');
      console.error('[real-repo-run-ai-readiness] No checkout was performed');
      console.error('[real-repo-run-ai-readiness] No main touch was performed');
      process.exit(1);
    }

    if (process.env.ALLOW_REAL_PROVIDER !== 'true') {
      console.error('[real-repo-run-ai-readiness] ALLOW_REAL_PROVIDER=true is required');
      console.error('[real-repo-run-ai-readiness] No provider call was made');
      console.error('[real-repo-run-ai-readiness] No apply was performed');
      console.error('[real-repo-run-ai-readiness] No commit was made');
      console.error('[real-repo-run-ai-readiness] No push was performed');
      process.exit(1);
    }

    if (process.env.ALLOW_REAL_REPO_APPLY !== 'true') {
      console.error('[real-repo-run-ai-readiness] ALLOW_REAL_REPO_APPLY=true is required');
      console.error('[real-repo-run-ai-readiness] No provider call was made');
      console.error('[real-repo-run-ai-readiness] No apply was performed');
      console.error('[real-repo-run-ai-readiness] No commit was made');
      console.error('[real-repo-run-ai-readiness] No push was performed');
      process.exit(1);
    }

    if (process.env.ALLOW_REAL_REPO_COMMIT !== 'true') {
      console.error('[real-repo-run-ai-readiness] ALLOW_REAL_REPO_COMMIT=true is required');
      console.error('[real-repo-run-ai-readiness] No provider call was made');
      console.error('[real-repo-run-ai-readiness] No apply was performed');
      console.error('[real-repo-run-ai-readiness] No commit was made');
      console.error('[real-repo-run-ai-readiness] No push was performed');
      process.exit(1);
    }

    if (process.env.ALLOW_REAL_REPO_PUSH !== 'true') {
      console.error('[real-repo-run-ai-readiness] ALLOW_REAL_REPO_PUSH=true is required');
      console.error('[real-repo-run-ai-readiness] No provider call was made');
      console.error('[real-repo-run-ai-readiness] No apply was performed');
      console.error('[real-repo-run-ai-readiness] No commit was made');
      console.error('[real-repo-run-ai-readiness] No push was performed');
      process.exit(1);
    }

    const task = loadTask(getTasksFilePath(), taskId);

    if (!existsSync(task.repo_path)) {
      throw new Error('repo_path does not exist');
    }
    if (!task.work_branch) {
      throw new Error('task.work_branch is missing');
    }
    if (task.work_branch === 'main') {
      throw new Error('task.work_branch is main');
    }

    const currentBranch = getCurrentBranch(task.repo_path);
    if (!currentBranch || currentBranch === 'HEAD') {
      throw new Error('Current branch is missing or detached HEAD');
    }
    if (currentBranch === 'main') {
      throw new Error('Current branch is main');
    }
    if (currentBranch !== task.work_branch) {
      throw new Error(
        `Branch mismatch: current=${currentBranch}, work_branch=${task.work_branch}`
      );
    }

    const statusResult = spawnSync('git', ['status', '--porcelain'], {
      cwd: task.repo_path,
      shell: false,
      encoding: 'utf-8',
    });
    if (statusResult.stdout && statusResult.stdout.trim().length > 0) {
      throw new Error('Working tree is not clean');
    }

    const headResult = spawnSync('git', ['rev-parse', '--verify', 'HEAD'], {
      cwd: task.repo_path,
      shell: false,
      encoding: 'utf-8',
    });
    if (headResult.status !== 0) {
      throw new Error('No local HEAD commit exists');
    }

    const remoteResult = spawnSync('git', ['remote', 'get-url', 'origin'], {
      cwd: task.repo_path,
      shell: false,
      encoding: 'utf-8',
    });
    if (remoteResult.status !== 0) {
      throw new Error('Remote origin does not exist');
    }
    if (!remoteResult.stdout || remoteResult.stdout.trim().length === 0) {
      throw new Error('Remote origin URL is empty');
    }

    const apiKey = process.env.KIMI_API_KEY?.trim();
    if (!apiKey) {
      throw new Error('KIMI_API_KEY env var is required');
    }

    const baseUrl = process.env.KIMI_BASE_URL?.trim();
    if (!baseUrl) {
      throw new Error('KIMI_BASE_URL env var is required');
    }

    console.error('[real-repo-run-ai-readiness] Readiness check passed');
    console.error(`[real-repo-run-ai-readiness] Task: ${taskId}`);
    console.error(`[real-repo-run-ai-readiness] Branch: ${currentBranch}`);
    console.error('[real-repo-run-ai-readiness] Provider opt-in: enabled');
    console.error('[real-repo-run-ai-readiness] Repo apply opt-in: enabled');
    console.error('[real-repo-run-ai-readiness] Repo commit opt-in: enabled');
    console.error('[real-repo-run-ai-readiness] Repo push opt-in: enabled');
    console.error('[real-repo-run-ai-readiness] Provider call: not performed');
    console.error('[real-repo-run-ai-readiness] Apply: not performed');
    console.error('[real-repo-run-ai-readiness] Commit: not performed');
    console.error('[real-repo-run-ai-readiness] Push: not performed');
    console.error(`[real-repo-run-ai-readiness] Ready to run: real-repo-run-ai ${taskId}`);
    process.exit(0);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[real-repo-run-ai-readiness] Error: ${message}`);
    console.error('[real-repo-run-ai-readiness] No provider call was made');
    console.error('[real-repo-run-ai-readiness] No apply was performed');
    console.error('[real-repo-run-ai-readiness] No commit was made');
    console.error('[real-repo-run-ai-readiness] No push was performed');
    console.error('[real-repo-run-ai-readiness] No merge was performed');
    console.error('[real-repo-run-ai-readiness] No checkout was performed');
    console.error('[real-repo-run-ai-readiness] No main touch was performed');
    process.exit(1);
  }
}

if (command === 'real-repo-approval-report') {
  try {
    if (!taskId) {
      console.error('[real-repo-approval-report] Error: task id is required');
      console.error('[real-repo-approval-report] No provider call was made');
      console.error('[real-repo-approval-report] No apply was performed');
      console.error('[real-repo-approval-report] No commit was made');
      console.error('[real-repo-approval-report] No push was performed');
      console.error('[real-repo-approval-report] No PR was created');
      console.error('[real-repo-approval-report] No merge was performed');
      console.error('[real-repo-approval-report] No checkout was performed');
      console.error('[real-repo-approval-report] No main touch was performed');
      process.exit(1);
    }

    if (process.env.ALLOW_REAL_REPO_APPROVAL_REPORT !== 'true') {
      console.error('[real-repo-approval-report] ALLOW_REAL_REPO_APPROVAL_REPORT=true is required');
      console.error('[real-repo-approval-report] No PR was created');
      console.error('[real-repo-approval-report] No merge was performed');
      console.error('[real-repo-approval-report] No checkout was performed');
      console.error('[real-repo-approval-report] No main touch was performed');
      process.exit(1);
    }

    const task = loadTask(getTasksFilePath(), taskId);

    if (!existsSync(task.repo_path)) {
      throw new Error('repo_path does not exist');
    }
    if (!task.work_branch) {
      throw new Error('task.work_branch is missing');
    }
    if (task.work_branch === 'main') {
      throw new Error('task.work_branch is main');
    }
    if (!task.base_branch) {
      throw new Error('task.base_branch is missing');
    }

    const state = loadState(taskId);
    if (!state) {
      throw new Error('State file does not exist');
    }
    if (state.task_id !== taskId) {
      throw new Error('State task_id mismatch');
    }
    if (state.status !== 'pushed') {
      throw new Error(`State status is ${state.status}, expected pushed`);
    }
    if (state.branch !== task.work_branch) {
      throw new Error('State branch mismatch');
    }
    if (state.pushed_remote !== 'origin') {
      throw new Error('State pushed_remote is not origin');
    }
    if (state.pushed_ref !== task.work_branch) {
      throw new Error('State pushed_ref mismatch');
    }
    if (!state.commit_sha) {
      throw new Error('State commit_sha is missing');
    }

    const commitVerify = spawnSync(
      'git',
      ['rev-parse', '--verify', '--end-of-options', `${state.commit_sha}^{commit}`],
      {
        cwd: task.repo_path,
        shell: false,
        encoding: 'utf-8',
      }
    );
    if (commitVerify.status !== 0) {
      throw new Error('Commit SHA does not exist in local repository');
    }

    let diffStat = '';
    const diffResult = spawnSync('git', ['diff', '--stat', `${task.base_branch}...${task.work_branch}`], {
      cwd: task.repo_path,
      shell: false,
      encoding: 'utf-8',
    });
    if (diffResult.status === 0 && diffResult.stdout) {
      diffStat = diffResult.stdout.trim();
    }

    const reportLines: string[] = [];
    reportLines.push(`# Manual Approval Report: ${taskId}`);
    reportLines.push('');
    reportLines.push(`- **Task ID:** ${taskId}`);
    reportLines.push(`- **Task Title:** ${task.title ?? 'N/A'}`);
    reportLines.push(`- **Goal:** ${task.goal ?? 'N/A'}`);
    reportLines.push(`- **Base Branch:** ${task.base_branch}`);
    reportLines.push(`- **Work Branch:** ${task.work_branch}`);
    reportLines.push(`- **Pushed Remote:** ${state.pushed_remote}`);
    reportLines.push(`- **Pushed Ref:** ${state.pushed_ref}`);
    reportLines.push(`- **Pushed Commit SHA:** ${state.commit_sha}`);
    reportLines.push(`- **State Status:** ${state.status}`);
    reportLines.push(`- **Safety Note:** ${state.safety_note ?? 'N/A'}`);
    reportLines.push('');
    reportLines.push('## Changed Files / Diff Stat');
    reportLines.push('');
    if (diffStat) {
      reportLines.push('```');
      reportLines.push(diffStat);
      reportLines.push('```');
    } else {
      reportLines.push('> Diff stat unavailable; inspect manually');
    }
    reportLines.push('');
    reportLines.push('## Manual Review Checklist');
    reportLines.push('');
    reportLines.push('- [ ] Inspect the diff carefully');
    reportLines.push('- [ ] Inspect the commit message and contents');
    reportLines.push('- [ ] Run tests locally if needed');
    reportLines.push('- [ ] Open PR manually if desired');
    reportLines.push('- [ ] Do not merge without human review');
    reportLines.push('- [ ] Do not force push');
    reportLines.push('- [ ] Do not touch main directly');
    reportLines.push('');
    reportLines.push('## Manual Commands');
    reportLines.push('');
    reportLines.push('```bash');
    reportLines.push(`git log --oneline ${task.base_branch}..${task.work_branch}`);
    reportLines.push(`git diff --stat ${task.base_branch}...${task.work_branch}`);
    reportLines.push(`git diff ${task.base_branch}...${task.work_branch}`);
    reportLines.push('# Optional: create PR manually (not executed by this tool)');
    reportLines.push(`# gh pr create --base ${task.base_branch} --head ${task.work_branch}`);
    reportLines.push('```');
    reportLines.push('');
    reportLines.push('## Hard Safety Statement');
    reportLines.push('');
    reportLines.push('- This tool did not create a PR.');
    reportLines.push('- This tool did not merge.');
    reportLines.push('- This tool did not checkout or switch branches.');
    reportLines.push('- This tool did not touch main.');
    reportLines.push('- This tool did not call provider.');
    reportLines.push('- This tool did not push.');
    reportLines.push('');

    const reportContent = reportLines.join('\n');
    const reportPath = join(getRunDir(taskId), 'approval-report.md');
    writeFileSync(reportPath, reportContent, 'utf-8');

    console.error('[real-repo-approval-report] Approval report written');
    console.error(`[real-repo-approval-report] Report path: ${reportPath}`);
    console.error('[real-repo-approval-report] No PR was created');
    console.error('[real-repo-approval-report] No merge was performed');
    console.error('[real-repo-approval-report] No checkout was performed');
    console.error('[real-repo-approval-report] No main touch was performed');
    process.exit(0);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[real-repo-approval-report] Error: ${message}`);
    console.error('[real-repo-approval-report] No provider call was made');
    console.error('[real-repo-approval-report] No apply was performed');
    console.error('[real-repo-approval-report] No commit was made');
    console.error('[real-repo-approval-report] No push was performed');
    console.error('[real-repo-approval-report] No PR was created');
    console.error('[real-repo-approval-report] No merge was performed');
    console.error('[real-repo-approval-report] No checkout was performed');
    console.error('[real-repo-approval-report] No main touch was performed');
    process.exit(1);
  }
}

if (command === 'real-repo-pr-readiness') {
  try {
    if (!taskId) {
      console.error('[real-repo-pr-readiness] Error: task id is required');
      console.error('[real-repo-pr-readiness] No provider call was made');
      console.error('[real-repo-pr-readiness] No apply was performed');
      console.error('[real-repo-pr-readiness] No commit was made');
      console.error('[real-repo-pr-readiness] No push was performed');
      console.error('[real-repo-pr-readiness] No PR was created');
      console.error('[real-repo-pr-readiness] No merge was performed');
      console.error('[real-repo-pr-readiness] No checkout was performed');
      console.error('[real-repo-pr-readiness] No main touch was performed');
      process.exit(1);
    }

    if (process.env.ALLOW_REAL_REPO_PR_READINESS !== 'true') {
      console.error('[real-repo-pr-readiness] ALLOW_REAL_REPO_PR_READINESS=true is required');
      console.error('[real-repo-pr-readiness] No PR was created');
      console.error('[real-repo-pr-readiness] No merge was performed');
      console.error('[real-repo-pr-readiness] No checkout was performed');
      console.error('[real-repo-pr-readiness] No main touch was performed');
      process.exit(1);
    }

    const task = loadTask(getTasksFilePath(), taskId);

    if (!existsSync(task.repo_path)) {
      throw new Error('repo_path does not exist');
    }
    if (!task.base_branch) {
      throw new Error('task.base_branch is missing');
    }
    if (!task.work_branch) {
      throw new Error('task.work_branch is missing');
    }
    if (task.work_branch === 'main') {
      throw new Error('task.work_branch is main');
    }

    const state = loadState(taskId);
    if (!state) {
      throw new Error('State file does not exist');
    }
    if (state.task_id !== taskId) {
      throw new Error('State task_id mismatch');
    }
    if (state.status !== 'pushed') {
      throw new Error(`State status is ${state.status}, expected pushed`);
    }
    if (state.branch !== task.work_branch) {
      throw new Error('State branch mismatch');
    }
    if (state.pushed_remote !== 'origin') {
      throw new Error('State pushed_remote is not origin');
    }
    if (state.pushed_ref !== task.work_branch) {
      throw new Error('State pushed_ref mismatch');
    }
    if (!state.commit_sha) {
      throw new Error('State commit_sha is missing');
    }

    const approvalReportPath = join(getRunDir(taskId), 'approval-report.md');
    if (!existsSync(approvalReportPath)) {
      throw new Error('Approval report is required before PR readiness');
    }

    const commitVerify = spawnSync(
      'git',
      ['rev-parse', '--verify', '--end-of-options', `${state.commit_sha}^{commit}`],
      {
        cwd: task.repo_path,
        shell: false,
        encoding: 'utf-8',
      }
    );
    if (commitVerify.status !== 0) {
      throw new Error('Commit SHA does not exist in local repository');
    }

    const baseBranchVerify = spawnSync('git', ['rev-parse', '--verify', '--end-of-options', task.base_branch], {
      cwd: task.repo_path,
      shell: false,
      encoding: 'utf-8',
    });
    if (baseBranchVerify.status !== 0) {
      throw new Error('Base branch does not exist in local repository');
    }

    const workBranchVerify = spawnSync('git', ['rev-parse', '--verify', '--end-of-options', task.work_branch], {
      cwd: task.repo_path,
      shell: false,
      encoding: 'utf-8',
    });
    if (workBranchVerify.status !== 0) {
      throw new Error('Work branch does not exist in local repository');
    }

    let diffStat = '';
    const diffResult = spawnSync('git', ['diff', '--stat', `${task.base_branch}...${task.work_branch}`], {
      cwd: task.repo_path,
      shell: false,
      encoding: 'utf-8',
    });
    if (diffResult.status === 0 && diffResult.stdout) {
      diffStat = diffResult.stdout.trim();
    }

    const prTitle = task.title ?? `AI task: ${taskId}`;

    const prBodyLines: string[] = [];
    prBodyLines.push(`## Task`);
    prBodyLines.push('');
    prBodyLines.push(`- **Task ID:** ${taskId}`);
    prBodyLines.push(`- **Goal:** ${task.goal ?? 'N/A'}`);
    prBodyLines.push(`- **Pushed Commit:** ${state.commit_sha}`);
    prBodyLines.push('');
    prBodyLines.push(`## Safety Note`);
    prBodyLines.push('');
    prBodyLines.push(`${state.safety_note ?? 'Human review required before merge'}`);
    prBodyLines.push('');
    prBodyLines.push(`## Checklist`);
    prBodyLines.push('');
    prBodyLines.push('- [ ] Inspect diff');
    prBodyLines.push('- [ ] Run tests locally if needed');
    prBodyLines.push('- [ ] Do not merge without human review');
    prBodyLines.push('');
    prBodyLines.push(`---`);
    prBodyLines.push(`*This PR body was generated by AI Orchestrator for human review.*`);

    const prBodyContent = prBodyLines.join('\n');
    const prBodyPath = join(getRunDir(taskId), 'pr-body.md');
    writeFileSync(prBodyPath, prBodyContent, 'utf-8');

    const reportLines: string[] = [];
    reportLines.push(`# PR Readiness Report: ${taskId}`);
    reportLines.push('');
    reportLines.push(`- **Task ID:** ${taskId}`);
    reportLines.push(`- **Task Title:** ${task.title ?? 'N/A'}`);
    reportLines.push(`- **Goal:** ${task.goal ?? 'N/A'}`);
    reportLines.push(`- **Base Branch:** ${task.base_branch}`);
    reportLines.push(`- **Work Branch:** ${task.work_branch}`);
    reportLines.push(`- **Pushed Commit SHA:** ${state.commit_sha}`);
    reportLines.push(`- **State Status:** ${state.status}`);
    reportLines.push(`- **Approval Report:** ${approvalReportPath}`);
    reportLines.push('');
    reportLines.push('## Diff Summary');
    reportLines.push('');
    if (diffStat) {
      reportLines.push('```');
      reportLines.push(diffStat);
      reportLines.push('```');
    } else {
      reportLines.push('> Diff stat unavailable; inspect manually');
    }
    reportLines.push('');
    reportLines.push('## PR Title Suggestion');
    reportLines.push('');
    reportLines.push(`\`${prTitle}\``);
    reportLines.push('');
    reportLines.push('## PR Body');
    reportLines.push('');
    reportLines.push(`See: \`${prBodyPath}\``);
    reportLines.push('');
    reportLines.push('## Manual Command');
    reportLines.push('');
    reportLines.push('```bash');
    reportLines.push('# Create PR manually (not executed by this tool)');
    reportLines.push(`# gh pr create --base ${task.base_branch} --head ${task.work_branch} --title "${prTitle}" --body-file ${prBodyPath}`);
    reportLines.push('```');
    reportLines.push('');
    reportLines.push('## Hard Safety Statement');
    reportLines.push('');
    reportLines.push('- This tool did not create a PR.');
    reportLines.push('- This tool did not call GitHub API.');
    reportLines.push('- This tool did not run gh.');
    reportLines.push('- This tool did not merge.');
    reportLines.push('- This tool did not checkout or switch branches.');
    reportLines.push('- This tool did not touch main.');
    reportLines.push('- This tool did not push.');
    reportLines.push('- This tool did not call provider.');
    reportLines.push('');

    const reportContent = reportLines.join('\n');
    const reportPath = join(getRunDir(taskId), 'pr-readiness.md');
    writeFileSync(reportPath, reportContent, 'utf-8');

    console.error('[real-repo-pr-readiness] PR readiness report written');
    console.error(`[real-repo-pr-readiness] Report path: ${reportPath}`);
    console.error(`[real-repo-pr-readiness] PR body path: ${prBodyPath}`);
    console.error('[real-repo-pr-readiness] No PR was created');
    console.error('[real-repo-pr-readiness] No GitHub API call was made');
    console.error('[real-repo-pr-readiness] No merge was performed');
    console.error('[real-repo-pr-readiness] No checkout was performed');
    console.error('[real-repo-pr-readiness] No main touch was performed');
    process.exit(0);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[real-repo-pr-readiness] Error: ${message}`);
    console.error('[real-repo-pr-readiness] No provider call was made');
    console.error('[real-repo-pr-readiness] No apply was performed');
    console.error('[real-repo-pr-readiness] No commit was made');
    console.error('[real-repo-pr-readiness] No push was performed');
    console.error('[real-repo-pr-readiness] No PR was created');
    console.error('[real-repo-pr-readiness] No merge was performed');
    console.error('[real-repo-pr-readiness] No checkout was performed');
    console.error('[real-repo-pr-readiness] No main touch was performed');
    process.exit(1);
  }
}

if (command === 'real-repo-pr-create') {
  try {
    if (!taskId) {
      console.error('[real-repo-pr-create] Error: task id is required');
      console.error('[real-repo-pr-create] No provider call was made');
      console.error('[real-repo-pr-create] No apply was performed');
      console.error('[real-repo-pr-create] No commit was made');
      console.error('[real-repo-pr-create] No push was performed');
      console.error('[real-repo-pr-create] No PR was created');
      console.error('[real-repo-pr-create] No merge was performed');
      console.error('[real-repo-pr-create] No checkout was performed');
      console.error('[real-repo-pr-create] No main touch was performed');
      process.exit(1);
    }

    if (process.env.ALLOW_GITHUB_PR_CREATE !== 'true') {
      console.error('[real-repo-pr-create] ALLOW_GITHUB_PR_CREATE=true is required');
      console.error('[real-repo-pr-create] No GitHub API call was made');
      console.error('[real-repo-pr-create] No PR was created');
      console.error('[real-repo-pr-create] No merge was performed');
      console.error('[real-repo-pr-create] No checkout was performed');
      console.error('[real-repo-pr-create] No main touch was performed');
      process.exit(1);
    }

    const githubToken = process.env.GITHUB_TOKEN;
    if (!githubToken) {
      console.error('[real-repo-pr-create] GITHUB_TOKEN is required');
      console.error('[real-repo-pr-create] No GitHub API call was made');
      console.error('[real-repo-pr-create] No PR was created');
      console.error('[real-repo-pr-create] No merge was performed');
      console.error('[real-repo-pr-create] No checkout was performed');
      console.error('[real-repo-pr-create] No main touch was performed');
      process.exit(1);
    }

    const githubRepo = process.env.GITHUB_REPOSITORY;
    if (!githubRepo) {
      console.error('[real-repo-pr-create] GITHUB_REPOSITORY is required');
      console.error('[real-repo-pr-create] No GitHub API call was made');
      console.error('[real-repo-pr-create] No PR was created');
      console.error('[real-repo-pr-create] No merge was performed');
      console.error('[real-repo-pr-create] No checkout was performed');
      console.error('[real-repo-pr-create] No main touch was performed');
      process.exit(1);
    }

    const repoParts = githubRepo.split('/');
    if (repoParts.length !== 2 || !repoParts[0] || !repoParts[1]) {
      console.error('[real-repo-pr-create] GITHUB_REPOSITORY must be in owner/repo format');
      console.error('[real-repo-pr-create] No GitHub API call was made');
      console.error('[real-repo-pr-create] No PR was created');
      console.error('[real-repo-pr-create] No merge was performed');
      console.error('[real-repo-pr-create] No checkout was performed');
      console.error('[real-repo-pr-create] No main touch was performed');
      process.exit(1);
    }

    const task = loadTask(getTasksFilePath(), taskId);

    if (!existsSync(task.repo_path)) {
      throw new Error('repo_path does not exist');
    }
    if (!task.base_branch) {
      throw new Error('base_branch is missing');
    }
    if (!task.work_branch) {
      throw new Error('work_branch is missing');
    }
    if (task.work_branch === 'main') {
      throw new Error('work_branch is main');
    }

    const state = loadState(taskId);
    if (!state) {
      throw new Error('State file does not exist');
    }
    if (state.task_id !== taskId) {
      throw new Error('State task_id mismatch');
    }
    if (state.status !== 'pushed') {
      throw new Error(`State status is "${state.status}", expected "pushed"`);
    }
    if (state.branch !== task.work_branch) {
      throw new Error('State branch mismatch');
    }
    if (state.pushed_remote !== 'origin') {
      throw new Error('State pushed_remote is not origin');
    }
    if (state.pushed_ref !== task.work_branch) {
      throw new Error('State pushed_ref mismatch');
    }
    if (!state.commit_sha) {
      throw new Error('State commit_sha is missing');
    }

    const runDir = getRunDir(taskId);
    const approvalReportPath = join(runDir, 'approval-report.md');
    if (!existsSync(approvalReportPath)) {
      throw new Error('Approval report is required before PR creation');
    }
    const prReadinessPath = join(runDir, 'pr-readiness.md');
    if (!existsSync(prReadinessPath)) {
      throw new Error('PR readiness report is required before PR creation');
    }
    const prBodyPath = join(runDir, 'pr-body.md');
    if (!existsSync(prBodyPath)) {
      throw new Error('PR body is required before PR creation');
    }

    const commitVerify = spawnSync(
      'git',
      ['rev-parse', '--verify', '--end-of-options', `${state.commit_sha}^{commit}`],
      {
        cwd: task.repo_path,
        shell: false,
        encoding: 'utf-8',
      }
    );
    if (commitVerify.status !== 0) {
      throw new Error('Commit SHA does not exist in local repository');
    }

    const baseRefVerify = spawnSync('git', ['rev-parse', '--verify', '--end-of-options', task.base_branch], {
      cwd: task.repo_path,
      shell: false,
      encoding: 'utf-8',
    });
    if (baseRefVerify.status !== 0) {
      throw new Error('Base branch ref does not exist in local repository');
    }

    const headRefVerify = spawnSync('git', ['rev-parse', '--verify', '--end-of-options', task.work_branch], {
      cwd: task.repo_path,
      shell: false,
      encoding: 'utf-8',
    });
    if (headRefVerify.status !== 0) {
      throw new Error('Work branch ref does not exist in local repository');
    }

    const prBody = readFileSync(prBodyPath, 'utf-8');
    const prTitle = task.title ?? `AI task: ${taskId}`;

    const apiBaseUrl = (process.env.GITHUB_API_BASE_URL ?? 'https://api.github.com').replace(/\/$/, '');
    const apiUrl = `${apiBaseUrl}/repos/${githubRepo}/pulls`;

    const requestBody = {
      title: prTitle,
      body: prBody,
      base: task.base_branch,
      head: task.work_branch,
    };

    let apiCallMade = false;
    const fakePrResponse = process.env.GITHUB_FAKE_PR_RESPONSE;
    const fakePrStatus = process.env.GITHUB_FAKE_PR_STATUS || '200';

    let response: Response;
    if (fakePrResponse !== undefined) {
      const statusCode = parseInt(fakePrStatus, 10);
      apiCallMade = true;
      console.error(`[github-api-call]`);
      console.error(`[github-api-request] POST ${apiUrl}`);
      console.error(`[github-api-request] body=${JSON.stringify(requestBody)}`);
      response = {
        ok: statusCode >= 200 && statusCode < 300,
        status: statusCode,
        json: async () => JSON.parse(fakePrResponse),
      } as Response;
    } else {
      apiCallMade = true;
      response = await fetch(apiUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${githubToken}`,
          Accept: 'application/vnd.github+json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(requestBody),
      });
    }

    if (!response.ok) {
      console.error('[real-repo-pr-create] Error: GitHub PR creation failed');
      console.error('[real-repo-pr-create] Manual inspection required');
      console.error('[real-repo-pr-create] No merge was performed');
      console.error('[real-repo-pr-create] No checkout was performed');
      console.error('[real-repo-pr-create] No main touch was performed');
      process.exit(1);
    }

    const responseData = await response.json();
    const prNumber = typeof responseData.number === 'number' ? responseData.number : 0;
    const prUrl = typeof responseData.html_url === 'string' ? responseData.html_url : '';

    const prCreated = {
      task_id: taskId,
      pr_number: prNumber,
      pr_url: prUrl,
      base: task.base_branch,
      head: task.work_branch,
      commit_sha: state.commit_sha,
      created_at: new Date().toISOString(),
      safety_note: 'PR created; merge not performed; human review required before merge',
    };

    const prCreatedPath = join(runDir, 'pr-created.json');
    writeFileSync(prCreatedPath, JSON.stringify(prCreated, null, 2), 'utf-8');

    console.error('[real-repo-pr-create] PR created');
    console.error(`[real-repo-pr-create] PR URL: ${prUrl}`);
    console.error('[real-repo-pr-create] No merge was performed');
    console.error('[real-repo-pr-create] No checkout was performed');
    console.error('[real-repo-pr-create] No main touch was performed');
    console.error('[real-repo-pr-create] Human review required before merge');
    process.exit(0);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[real-repo-pr-create] Error: ${message}`);
    console.error('[real-repo-pr-create] No merge was performed');
    console.error('[real-repo-pr-create] No checkout was performed');
    console.error('[real-repo-pr-create] No main touch was performed');
    process.exit(1);
  }
}

if (command === 'real-repo-pr-status') {
  try {
    if (!taskId) {
      console.error('[real-repo-pr-status] Error: task id is required');
      console.error('[real-repo-pr-status] No provider call was made');
      console.error('[real-repo-pr-status] No apply was performed');
      console.error('[real-repo-pr-status] No commit was made');
      console.error('[real-repo-pr-status] No push was performed');
      console.error('[real-repo-pr-status] No PR was created');
      console.error('[real-repo-pr-status] No PR was updated');
      console.error('[real-repo-pr-status] No merge was performed');
      console.error('[real-repo-pr-status] No checkout was performed');
      console.error('[real-repo-pr-status] No main touch was performed');
      process.exit(1);
    }

    if (process.env.ALLOW_GITHUB_PR_STATUS !== 'true') {
      console.error('[real-repo-pr-status] ALLOW_GITHUB_PR_STATUS=true is required');
      console.error('[real-repo-pr-status] No GitHub API call was made');
      console.error('[real-repo-pr-status] No PR was updated');
      console.error('[real-repo-pr-status] No merge was performed');
      console.error('[real-repo-pr-status] No checkout was performed');
      console.error('[real-repo-pr-status] No main touch was performed');
      process.exit(1);
    }

    const githubToken = process.env.GITHUB_TOKEN;
    if (!githubToken) {
      console.error('[real-repo-pr-status] GITHUB_TOKEN is required');
      console.error('[real-repo-pr-status] No GitHub API call was made');
      console.error('[real-repo-pr-status] No PR was updated');
      console.error('[real-repo-pr-status] No merge was performed');
      console.error('[real-repo-pr-status] No checkout was performed');
      console.error('[real-repo-pr-status] No main touch was performed');
      process.exit(1);
    }

    const githubRepo = process.env.GITHUB_REPOSITORY;
    if (!githubRepo) {
      console.error('[real-repo-pr-status] GITHUB_REPOSITORY is required');
      console.error('[real-repo-pr-status] No GitHub API call was made');
      console.error('[real-repo-pr-status] No PR was updated');
      console.error('[real-repo-pr-status] No merge was performed');
      console.error('[real-repo-pr-status] No checkout was performed');
      console.error('[real-repo-pr-status] No main touch was performed');
      process.exit(1);
    }

    const repoParts = githubRepo.split('/');
    if (repoParts.length !== 2 || !repoParts[0] || !repoParts[1]) {
      console.error('[real-repo-pr-status] GITHUB_REPOSITORY must be in owner/repo format');
      console.error('[real-repo-pr-status] No GitHub API call was made');
      console.error('[real-repo-pr-status] No PR was updated');
      console.error('[real-repo-pr-status] No merge was performed');
      console.error('[real-repo-pr-status] No checkout was performed');
      console.error('[real-repo-pr-status] No main touch was performed');
      process.exit(1);
    }

    const task = loadTask(getTasksFilePath(), taskId);

    if (!existsSync(task.repo_path)) {
      throw new Error('repo_path does not exist');
    }
    if (!task.base_branch) {
      throw new Error('base_branch is missing');
    }
    if (!task.work_branch) {
      throw new Error('work_branch is missing');
    }
    if (task.work_branch === 'main') {
      throw new Error('work_branch is main');
    }

    const state = loadState(taskId);
    if (!state) {
      throw new Error('State file does not exist');
    }
    if (state.task_id !== taskId) {
      throw new Error('State task_id mismatch');
    }
    if (state.status !== 'pushed') {
      throw new Error(`State status is "${state.status}", expected "pushed"`);
    }
    if (state.branch !== task.work_branch) {
      throw new Error('State branch mismatch');
    }
    if (state.pushed_remote !== 'origin') {
      throw new Error('State pushed_remote is not origin');
    }
    if (state.pushed_ref !== task.work_branch) {
      throw new Error('State pushed_ref mismatch');
    }
    if (!state.commit_sha) {
      throw new Error('State commit_sha is missing');
    }

    const runDir = getRunDir(taskId);
    const approvalReportPath = join(runDir, 'approval-report.md');
    if (!existsSync(approvalReportPath)) {
      throw new Error('Approval report is required before PR status check');
    }
    const prReadinessPath = join(runDir, 'pr-readiness.md');
    if (!existsSync(prReadinessPath)) {
      throw new Error('PR readiness report is required before PR status check');
    }
    const prBodyPath = join(runDir, 'pr-body.md');
    if (!existsSync(prBodyPath)) {
      throw new Error('PR body is required before PR status check');
    }
    const prCreatedPath = join(runDir, 'pr-created.json');
    if (!existsSync(prCreatedPath)) {
      throw new Error('pr-created.json is required before PR status check');
    }

    let prCreated: Record<string, unknown>;
    try {
      prCreated = JSON.parse(readFileSync(prCreatedPath, 'utf-8'));
    } catch {
      throw new Error('pr-created.json is malformed');
    }
    if (prCreated.task_id !== taskId) {
      throw new Error('pr-created.json task_id mismatch');
    }
    if (typeof prCreated.pr_number !== 'number' || prCreated.pr_number <= 0 || !Number.isFinite(prCreated.pr_number)) {
      throw new Error('pr-created.json pr_number is invalid');
    }
    if (!prCreated.pr_url) {
      throw new Error('pr-created.json pr_url is missing');
    }
    if (prCreated.base !== task.base_branch) {
      throw new Error('pr-created.json base branch mismatch');
    }
    if (prCreated.head !== task.work_branch) {
      throw new Error('pr-created.json head branch mismatch');
    }
    if (prCreated.commit_sha !== state.commit_sha) {
      throw new Error('pr-created.json commit_sha mismatch');
    }

    const commitVerify = spawnSync(
      'git',
      ['rev-parse', '--verify', '--end-of-options', `${state.commit_sha}^{commit}`],
      {
        cwd: task.repo_path,
        shell: false,
        encoding: 'utf-8',
      }
    );
    if (commitVerify.status !== 0) {
      throw new Error('Commit SHA does not exist in local repository');
    }

    const apiBaseUrl = (process.env.GITHUB_API_BASE_URL ?? 'https://api.github.com').replace(/\/$/, '');
    const prNumber = prCreated.pr_number as number;

    const headers: Record<string, string> = {
      Authorization: `Bearer ${githubToken}`,
      Accept: 'application/vnd.github+json',
    };

    const fakePrResponse = process.env.GITHUB_FAKE_PR_RESPONSE;
    const fakeStatusResponse = process.env.GITHUB_FAKE_STATUS_RESPONSE;
    const fakeChecksResponse = process.env.GITHUB_FAKE_CHECKS_RESPONSE;
    const fakePrStatus = process.env.GITHUB_FAKE_PR_STATUS || '200';

    async function githubGet(url: string): Promise<Response> {
      if (fakePrResponse !== undefined) {
        const statusCode = parseInt(fakePrStatus, 10);
        console.error(`[github-api-call]`);
        console.error(`[github-api-request] GET ${url}`);
        let body: unknown = {};
        if (url.includes('/pulls/') && !url.includes('/status')) {
          body = JSON.parse(fakePrResponse);
        } else if (url.includes('/status')) {
          body = fakeStatusResponse ? JSON.parse(fakeStatusResponse) : { state: 'pending', total_count: 0, statuses: [] };
        } else if (url.includes('/check-runs')) {
          body = fakeChecksResponse ? JSON.parse(fakeChecksResponse) : { total_count: 0, check_runs: [] };
        }
        return {
          ok: statusCode >= 200 && statusCode < 300,
          status: statusCode,
          json: async () => body,
        } as Response;
      }
      return fetch(url, { method: 'GET', headers });
    }

    const prUrl = `${apiBaseUrl}/repos/${githubRepo}/pulls/${prNumber}`;
    const prResponse = await githubGet(prUrl);
    if (!prResponse.ok) {
      console.error('[real-repo-pr-status] Error: GitHub PR status fetch failed');
      console.error('[real-repo-pr-status] Manual inspection required');
      console.error('[real-repo-pr-status] No PR was updated');
      console.error('[real-repo-pr-status] No merge was performed');
      console.error('[real-repo-pr-status] No checkout was performed');
      console.error('[real-repo-pr-status] No main touch was performed');
      process.exit(1);
    }
    const prData = (await prResponse.json()) as Record<string, unknown>;

    const statusUrl = `${apiBaseUrl}/repos/${githubRepo}/commits/${state.commit_sha}/status`;
    const statusResponse = await githubGet(statusUrl);
    let statusData: Record<string, unknown> = { state: 'unknown', total_count: 0, statuses: [] };
    if (statusResponse.ok) {
      statusData = (await statusResponse.json()) as Record<string, unknown>;
    }

    const checksUrl = `${apiBaseUrl}/repos/${githubRepo}/commits/${state.commit_sha}/check-runs`;
    const checksResponse = await githubGet(checksUrl);
    let checksData: Record<string, unknown> = { total_count: 0, check_runs: [] };
    if (checksResponse.ok) {
      checksData = (await checksResponse.json()) as Record<string, unknown>;
    }

    const prState = typeof prData.state === 'string' ? prData.state : 'unknown';
    const prDraft = prData.draft === true;
    const prTitle = typeof prData.title === 'string' ? prData.title : '';
    const prHtmlUrl = typeof prData.html_url === 'string' ? prData.html_url : String(prCreated.pr_url);
    const prUser = prData.user && typeof (prData.user as Record<string, unknown>).login === 'string'
      ? (prData.user as Record<string, unknown>).login as string
      : '';
    const prMergeable = prData.mergeable;
    const prMergeableState = typeof prData.mergeable_state === 'string' ? prData.mergeable_state : '';

    const combinedStatusState = typeof statusData.state === 'string' ? statusData.state : 'unknown';
    const statusTotalCount = typeof statusData.total_count === 'number' ? statusData.total_count : 0;
    const statuses = Array.isArray(statusData.statuses) ? statusData.statuses as Record<string, unknown>[] : [];

    const checkRunTotalCount = typeof checksData.total_count === 'number' ? checksData.total_count : 0;
    const checkRuns = Array.isArray(checksData.check_runs) ? checksData.check_runs as Record<string, unknown>[] : [];

    let nextStep = 'Human inspection required';
    if (prState === 'open') {
      if (combinedStatusState === 'success' && checkRuns.every((c) => c.conclusion === 'success' || c.conclusion === 'skipped' || c.conclusion === null)) {
        nextStep = 'Ready for human review; merge still manual';
      } else if (combinedStatusState === 'pending' || checkRuns.some((c) => c.status !== 'completed')) {
        nextStep = 'Wait for checks';
      }
    }

    const now = new Date().toISOString();

    const prStatusJson = {
      task_id: taskId,
      pr_number: prNumber,
      pr_url: prHtmlUrl,
      pr_state: prState,
      draft: prDraft,
      base: task.base_branch,
      head: task.work_branch,
      commit_sha: state.commit_sha,
      combined_status_state: combinedStatusState,
      status_count: statusTotalCount,
      check_run_count: checkRunTotalCount,
      created_at: now,
      safety_note: 'PR status read-only; merge not performed; human review required before merge',
    };

    const prStatusJsonPath = join(runDir, 'pr-status.json');
    writeFileSync(prStatusJsonPath, JSON.stringify(prStatusJson, null, 2), 'utf-8');

    const reportLines: string[] = [];
    reportLines.push(`# PR Status Report: ${taskId}`);
    reportLines.push('');
    reportLines.push(`- **Task ID:** ${taskId}`);
    reportLines.push(`- **PR Number:** ${prNumber}`);
    reportLines.push(`- **PR URL:** ${prHtmlUrl}`);
    reportLines.push(`- **PR State:** ${prState}`);
    reportLines.push(`- **Draft:** ${prDraft ? 'Yes' : 'No'}`);
    reportLines.push(`- **Title:** ${prTitle}`);
    reportLines.push(`- **Base Branch:** ${task.base_branch}`);
    reportLines.push(`- **Head Branch:** ${task.work_branch}`);
    reportLines.push(`- **Pushed Commit SHA:** ${state.commit_sha}`);
    if (prUser) {
      reportLines.push(`- **Author:** ${prUser}`);
    }
    if (prMergeable !== undefined) {
      reportLines.push(`- **Mergeable:** ${prMergeable}`);
    }
    if (prMergeableState) {
      reportLines.push(`- **Mergeable State:** ${prMergeableState}`);
    }
    reportLines.push('');
    reportLines.push('## Combined Status');
    reportLines.push('');
    reportLines.push(`- **State:** ${combinedStatusState}`);
    reportLines.push(`- **Total Statuses:** ${statusTotalCount}`);
    if (statuses.length > 0) {
      reportLines.push('');
      reportLines.push('| Context | State | Description |');
      reportLines.push('|---------|-------|-------------|');
      for (const s of statuses) {
        const ctx = typeof s.context === 'string' ? s.context : '';
        const st = typeof s.state === 'string' ? s.state : '';
        const desc = typeof s.description === 'string' ? s.description : '';
        reportLines.push(`| ${ctx} | ${st} | ${desc} |`);
      }
    }
    reportLines.push('');
    reportLines.push('## Check Runs');
    reportLines.push('');
    reportLines.push(`- **Total Check Runs:** ${checkRunTotalCount}`);
    if (checkRuns.length > 0) {
      reportLines.push('');
      reportLines.push('| Name | Status | Conclusion |');
      reportLines.push('|------|--------|------------|');
      for (const c of checkRuns) {
        const name = typeof c.name === 'string' ? c.name : '';
        const st = typeof c.status === 'string' ? c.status : '';
        const conc = typeof c.conclusion === 'string' ? c.conclusion : '';
        reportLines.push(`| ${name} | ${st} | ${conc} |`);
      }
    }
    reportLines.push('');
    reportLines.push('## Next Step');
    reportLines.push('');
    reportLines.push(`> ${nextStep}`);
    reportLines.push('');
    reportLines.push('## Hard Safety Statement');
    reportLines.push('');
    reportLines.push('- This tool did not create a PR.');
    reportLines.push('- This tool did not update a PR.');
    reportLines.push('- This tool did not merge.');
    reportLines.push('- This tool did not checkout or switch branches.');
    reportLines.push('- This tool did not touch main.');
    reportLines.push('- This tool did not push.');
    reportLines.push('- This tool did not call provider.');
    reportLines.push('');

    const reportContent = reportLines.join('\n');
    const reportPath = join(runDir, 'pr-status-report.md');
    writeFileSync(reportPath, reportContent, 'utf-8');

    console.error('[real-repo-pr-status] PR status report written');
    console.error(`[real-repo-pr-status] Report path: ${reportPath}`);
    console.error(`[real-repo-pr-status] Status path: ${prStatusJsonPath}`);
    console.error('[real-repo-pr-status] No PR was created');
    console.error('[real-repo-pr-status] No PR was updated');
    console.error('[real-repo-pr-status] No merge was performed');
    console.error('[real-repo-pr-status] No checkout was performed');
    console.error('[real-repo-pr-status] No main touch was performed');
    process.exit(0);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[real-repo-pr-status] Error: ${message}`);
    console.error('[real-repo-pr-status] No merge was performed');
    console.error('[real-repo-pr-status] No checkout was performed');
    console.error('[real-repo-pr-status] No main touch was performed');
    process.exit(1);
  }
}

if (command === 'real-block-run-ai-readiness') {
  try {
    if (!taskId) {
      console.error('[real-block-run-ai-readiness] Error: block definition path is required');
      process.exit(1);
    }

    const resume = args.slice(2).includes('--resume');
    const report = checkRealBlockRunReadiness(taskId, { resume });
    console.log(redactSecrets(JSON.stringify(report, null, 2)));
    process.exit(report.ready ? 0 : 1);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[real-block-run-ai-readiness] Error: ${redactSecrets(message)}`);
    process.exit(1);
  }
}

if (command === 'real-block-run-ai') {
  try {
    if (!taskId) {
      console.error('[real-block-run-ai] Error: block definition path is required');
      console.error('[real-block-run-ai] No provider call was made');
      console.error('[real-block-run-ai] No apply was performed');
      console.error('[real-block-run-ai] No commit was made');
      console.error('[real-block-run-ai] No push was performed');
      console.error('[real-block-run-ai] No merge was performed');
      console.error('[real-block-run-ai] No checkout was performed');
      console.error('[real-block-run-ai] No main touch was performed');
      process.exitCode = 1;
      break commandDispatch;
    }

    const resume = args.slice(2).includes('--resume');
    const { exitCode } = await runRealBlockRunAI(taskId, { resume });
    process.exitCode = exitCode;
    break commandDispatch;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[real-block-run-ai] Error: ${redactSecrets(message)}`);
    console.error('[real-block-run-ai] No provider call was made');
    console.error('[real-block-run-ai] No apply was performed');
    console.error('[real-block-run-ai] No commit was made');
    console.error('[real-block-run-ai] No push was performed');
    console.error('[real-block-run-ai] No merge was performed');
    console.error('[real-block-run-ai] No checkout was performed');
    console.error('[real-block-run-ai] No main touch was performed');
    process.exitCode = 1;
    break commandDispatch;
  }
}

if (command === 'real-block-run-ai-report') {
  try {
    if (!taskId) {
      console.error('[real-block-run-ai-report] Error: block state path is required');
      console.error('[real-block-run-ai-report] No state file was read');
      console.error('[real-block-run-ai-report] No provider call was made');
      console.error('[real-block-run-ai-report] No commit was made');
      console.error('[real-block-run-ai-report] No push was performed');
      console.error('[real-block-run-ai-report] No merge was performed');
      process.exit(1);
    }

    const report = renderBlockRunReport(taskId);
    console.log(report);
    process.exit(0);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[real-block-run-ai-report] Error: ${redactSecrets(message)}`);
    console.error('[real-block-run-ai-report] No state mutation was performed');
    console.error('[real-block-run-ai-report] No provider call was made');
    console.error('[real-block-run-ai-report] No commit was made');
    console.error('[real-block-run-ai-report] No push was performed');
    console.error('[real-block-run-ai-report] No merge was performed');
    process.exit(1);
  }
}

if (command === 'real-block-run-ai-checklist') {
  try {
    if (!taskId) {
      console.error('[real-block-run-ai-checklist] Error: block definition path is required');
      console.error('[real-block-run-ai-checklist] No provider call was made');
      console.error('[real-block-run-ai-checklist] No repo mutation was performed');
      console.error('[real-block-run-ai-checklist] No state mutation was performed');
      process.exit(1);
    }

    const resume = args.includes('--resume');
    const strict = args.includes('--strict');
    const providerFlagIndex = args.indexOf('--provider');
    const provider = providerFlagIndex >= 0 && args[providerFlagIndex + 1] ? args[providerFlagIndex + 1] : undefined;

    const report = checkRealBlockRunAIChecklist(taskId, { resume, provider, strict });
    console.log(formatCheckRealBlockRunAIChecklistReport(report));
    process.exit(report.ok ? 0 : 1);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[real-block-run-ai-checklist] Error: ${redactSecrets(message)}`);
    console.error('[real-block-run-ai-checklist] No provider call was made');
    console.error('[real-block-run-ai-checklist] No repo mutation was performed');
    console.error('[real-block-run-ai-checklist] No state mutation was performed');
    process.exit(1);
  }
}

if (command === 'real-block-run-ai-dry-run') {
  try {
    if (!taskId) {
      console.error('[real-block-run-ai-dry-run] Error: block definition path is required');
      console.error('[real-block-run-ai-dry-run] No provider call was made');
      console.error('[real-block-run-ai-dry-run] No repo mutation was performed');
      console.error('[real-block-run-ai-dry-run] No state mutation was performed');
      process.exit(1);
    }

    const resume = args.includes('--resume');
    const providerFlagIndex = args.indexOf('--provider');
    const provider = providerFlagIndex >= 0 && args[providerFlagIndex + 1] ? args[providerFlagIndex + 1] : undefined;

    const report = createRealBlockRunAIDryRunReport(taskId, { resume, provider });
    console.log(formatRealBlockRunAIDryRunReport(report));
    process.exit(report.ok ? 0 : 1);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[real-block-run-ai-dry-run] Error: ${redactSecrets(message)}`);
    console.error('[real-block-run-ai-dry-run] No provider call was made');
    console.error('[real-block-run-ai-dry-run] No repo mutation was performed');
    console.error('[real-block-run-ai-dry-run] No state mutation was performed');
    process.exit(1);
  }
}

if (command === 'real-block-init') {
  try {
    if (!taskId) {
      console.error('[real-block-init] Error: output path is required');
      console.error('[real-block-init] No provider call was made');
      console.error('[real-block-init] No network call was made');
      console.error('[real-block-init] No git mutation was performed');
      console.error('[real-block-init] No state mutation was performed');
      process.exit(1);
    }

    const force = args.includes('--force');
    const blockId = getFlagValue(args, '--block-id');
    const title = getFlagValue(args, '--title');
    const repoPath = getFlagValue(args, '--repo-path');
    const baseBranch = getFlagValue(args, '--base-branch');
    const workBranch = getFlagValue(args, '--work-branch');
    const taskIdFlag = getFlagValue(args, '--task-id');
    const taskTitle = getFlagValue(args, '--task-title');

    const report = createRealBlockInitFile(taskId, {
      force,
      blockId,
      title,
      repoPath,
      baseBranch,
      workBranch,
      taskId: taskIdFlag,
      taskTitle,
    });
    console.log(formatRealBlockInitReport(report));
    process.exit(report.ok ? 0 : 1);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[real-block-init] Error: ${redactSecrets(message)}`);
    console.error('[real-block-init] No provider call was made');
    console.error('[real-block-init] No network call was made');
    console.error('[real-block-init] No git mutation was performed');
    console.error('[real-block-init] No state mutation was performed');
    process.exit(1);
  }
}

if (command === 'real-block-validate') {
  try {
    if (!taskId) {
      console.error('[real-block-validate] Error: block path is required');
      console.error('[real-block-validate] No provider call was made');
      console.error('[real-block-validate] No network call was made');
      console.error('[real-block-validate] No git mutation was performed');
      console.error('[real-block-validate] No state mutation was performed');
      const report = validateRealBlockFile('');
      console.log(formatRealBlockValidateReport(report));
      process.exit(1);
    }

    const strict = args.includes('--strict');
    const report = validateRealBlockFile(taskId, { strict });
    console.log(formatRealBlockValidateReport(report));
    process.exit(report.ok ? 0 : 1);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[real-block-validate] Error: ${redactSecrets(message)}`);
    console.error('[real-block-validate] No provider call was made');
    console.error('[real-block-validate] No network call was made');
    console.error('[real-block-validate] No git mutation was performed');
    console.error('[real-block-validate] No state mutation was performed');
    process.exit(1);
  }
}

if (command === 'real-provider-smoke') {
  try {
    const providerFlagIndex = args.indexOf('--provider');
    const provider = providerFlagIndex >= 0 && args[providerFlagIndex + 1] ? args[providerFlagIndex + 1] : 'kimi';

    const report = await runRealProviderSmoke(provider);
    console.log(redactSecrets(JSON.stringify(report, null, 2)));
    process.exitCode = report.ok ? 0 : 1;
    break commandDispatch;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const report = {
      ok: false,
      provider: 'kimi',
      mode: 'real-provider-smoke',
      responseParsed: false,
      error: redactSecrets(message),
    };
    console.error(`[real-provider-smoke] Error: ${redactSecrets(message)}`);
    console.log(redactSecrets(JSON.stringify(report, null, 2)));
    console.error('[real-provider-smoke] No API call was made');
    console.error('[real-provider-smoke] No patch was applied');
    console.error('[real-provider-smoke] No git mutation was performed');
    console.error('[real-provider-smoke] No state mutation was performed');
    process.exitCode = 1;
    break commandDispatch;
  }
}

if (command === 'real-coder-contract-smoke') {
  try {
    const providerFlagIndex = args.indexOf('--provider');
    const provider = providerFlagIndex >= 0 && args[providerFlagIndex + 1] ? args[providerFlagIndex + 1] : 'kimi';
    const timeoutFlagIndex = args.indexOf('--timeout-ms');
    const timeoutMs =
      timeoutFlagIndex >= 0 && args[timeoutFlagIndex + 1]
        ? Number(args[timeoutFlagIndex + 1])
        : undefined;

    const report = await runRealCoderContractSmoke({ provider, timeoutMs });
    console.log(formatRealCoderContractSmokeReport(report));
    process.exitCode = report.ok ? 0 : 1;
    break commandDispatch;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const report = {
      ok: false,
      provider: 'kimi',
      mode: 'real-coder-contract-smoke',
      supported: true,
      contractValid: false,
      error: redactSecrets(message),
    };
    console.error(`[real-coder-contract-smoke] Error: ${redactSecrets(message)}`);
    console.log(redactSecrets(JSON.stringify(report, null, 2)));
    console.error('[real-coder-contract-smoke] No API call was made');
    console.error('[real-coder-contract-smoke] No patch was applied');
    console.error('[real-coder-contract-smoke] No file was written');
    console.error('[real-coder-contract-smoke] No git mutation was performed');
    console.error('[real-coder-contract-smoke] No state mutation was performed');
    process.exitCode = 1;
    break commandDispatch;
  }
}

if (command === 'real-reviewer-contract-smoke') {
  try {
    const providerFlagIndex = args.indexOf('--provider');
    const provider = providerFlagIndex >= 0 && args[providerFlagIndex + 1] ? args[providerFlagIndex + 1] : 'kimi';
    const timeoutFlagIndex = args.indexOf('--timeout-ms');
    const timeoutMs =
      timeoutFlagIndex >= 0 && args[timeoutFlagIndex + 1]
        ? Number(args[timeoutFlagIndex + 1])
        : undefined;

    const report = await runRealReviewerContractSmoke({ provider, timeoutMs });
    console.log(formatRealReviewerContractSmokeReport(report));
    process.exitCode = report.ok ? 0 : 1;
    break commandDispatch;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const report = {
      ok: false,
      provider: 'kimi',
      mode: 'real-reviewer-contract-smoke',
      supported: true,
      contractValid: false,
      error: redactSecrets(message),
    };
    console.error(`[real-reviewer-contract-smoke] Error: ${redactSecrets(message)}`);
    console.log(redactSecrets(JSON.stringify(report, null, 2)));
    console.error('[real-reviewer-contract-smoke] No API call was made');
    console.error('[real-reviewer-contract-smoke] No patch was applied');
    console.error('[real-reviewer-contract-smoke] No file was written');
    console.error('[real-reviewer-contract-smoke] No git mutation was performed');
    console.error('[real-reviewer-contract-smoke] No state mutation was performed');
    process.exitCode = 1;
    break commandDispatch;
  }
}

if (command === 'real-block-preflight') {
  try {
    if (!taskId) {
      console.error('[real-block-preflight] Error: block path is required');
      console.error('[real-block-preflight] No provider call was made');
      console.error('[real-block-preflight] No network call was made');
      console.error('[real-block-preflight] No repo mutation was performed');
      console.error('[real-block-preflight] No state mutation was performed');
      process.exitCode = 1;
      break commandDispatch;
    }

    const resume = args.includes('--resume');
    const providerFlagIndex = args.indexOf('--provider');
    const provider = providerFlagIndex >= 0 && args[providerFlagIndex + 1] ? args[providerFlagIndex + 1] : undefined;
    const timeoutFlagIndex = args.indexOf('--timeout-ms');
    const timeoutMs = timeoutFlagIndex >= 0 && args[timeoutFlagIndex + 1] ? Number(args[timeoutFlagIndex + 1]) : undefined;

    const report = await runRealBlockPreflight({ blockPath: taskId, resume, provider, timeoutMs });
    console.log(formatRealBlockPreflightReport(report));
    process.exitCode = report.ok ? 0 : 1;
    break commandDispatch;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[real-block-preflight] Error: ${redactSecrets(message)}`);
    console.error('[real-block-preflight] No provider call was made');
    console.error('[real-block-preflight] No network call was made');
    console.error('[real-block-preflight] No repo mutation was performed');
    console.error('[real-block-preflight] No state mutation was performed');
    process.exitCode = 1;
    break commandDispatch;
  }
}

if (command === 'real-block-task-probe') {
  try {
    if (!taskId) {
      console.error('[real-block-task-probe] Error: block path is required');
      console.error('[real-block-task-probe] No provider call was made');
      console.error('[real-block-task-probe] No network call was made');
      console.error('[real-block-task-probe] No repo mutation was performed');
      console.error('[real-block-task-probe] No state mutation was performed');
      const emptyReport = await runRealBlockTaskProbe({
        blockPath: '',
        provider: 'kimi',
        env: { ...process.env, ALLOW_REAL_PROVIDER: '', KIMI_API_KEY: '', KIMI_BASE_URL: '' },
      });
      console.log(formatRealBlockTaskProbeReport(emptyReport));
      process.exitCode = 1;
      break commandDispatch;
    }

    const providerFlagIndex = args.indexOf('--provider');
    const provider = providerFlagIndex >= 0 && args[providerFlagIndex + 1] ? args[providerFlagIndex + 1] : undefined;
    const taskIdFlagIndex = args.indexOf('--task-id');
    const taskIdFlag = taskIdFlagIndex >= 0 && args[taskIdFlagIndex + 1] ? args[taskIdFlagIndex + 1] : undefined;
    const timeoutFlagIndex = args.indexOf('--timeout-ms');
    const timeoutMs = timeoutFlagIndex >= 0 && args[timeoutFlagIndex + 1] ? Number(args[timeoutFlagIndex + 1]) : undefined;

    const report = await runRealBlockTaskProbe({ blockPath: taskId, provider, taskId: taskIdFlag, timeoutMs });
    console.log(formatRealBlockTaskProbeReport(report));
    process.exitCode = report.ok ? 0 : 1;
    break commandDispatch;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[real-block-task-probe] Error: ${redactSecrets(message)}`);
    console.error('[real-block-task-probe] No provider call was made');
    console.error('[real-block-task-probe] No network call was made');
    console.error('[real-block-task-probe] No repo mutation was performed');
    console.error('[real-block-task-probe] No state mutation was performed');
    process.exitCode = 1;
    break commandDispatch;
  }
}

if (!command || !taskId) {
  console.error(
    'Usage: npx tsx src/cli.ts <run|status|git-check|git-diff|mock-apply|attempt|context|prompt|validate-output|ai-generate|ai-validate|ai-preview|ai-apply|ai-run|ai-output-status|agent-once|pipeline-loop|real-provider-plan|real-provider-run|real-provider-preview|real-provider-smoke|real-coder-contract-smoke [--provider kimi] [--timeout-ms <ms>]|real-reviewer-contract-smoke [--provider kimi] [--timeout-ms <ms>]|real-block-preflight [--resume] [--provider kimi] [--timeout-ms <ms>]|real-block-task-probe [--provider kimi] [--task-id <id>] [--timeout-ms <ms>]|real-block-init|real-block-validate [--strict]|real-block-run-ai-checklist [--resume] [--strict]|real-block-run-ai-dry-run [--resume] [--provider kimi]|provider-preview|sandbox-apply-preview|real-repo-apply-dry-run|real-repo-apply|real-repo-commit|real-repo-push|real-repo-run|real-repo-run-ai|real-repo-run-ai-readiness|real-block-run-ai [--resume]|real-block-run-ai-readiness [--resume]|real-block-run-ai-report|real-repo-approval-report|real-repo-pr-readiness|real-repo-pr-create|real-repo-pr-status|reviewer-gate-dry-run|reviewer-gate-evidence-dry-run|block-init|block-status|block-transition|block-run-one|block-run|block-approval-report|block-pr-draft|block-pr-create|block-pr-status|block-pr-readiness|block-pr-cleanup|block-pr-submit|block-sandbox> <taskId> [arg3] [arg4]'
  );
  process.exit(1);
}

if (command === 'status') {
  try {
    const task = loadTask(getTasksFilePath(), taskId);
    const state = loadState(taskId);

    console.log(`[status] Task: ${taskId}`);
    console.log(`Title: ${task.title}`);

    if (!state) {
      console.log('No runs recorded yet.');
      console.log(`Start with: npx tsx src/cli.ts run ${taskId}`);
    } else {
      console.log(`Status: ${state.status}`);
      console.log(`Attempt: ${state.current_attempt}`);
      console.log(`Branch: ${state.branch}`);
      console.log(`Updated: ${state.updated_at}`);

      const rawLogs = state.last_logs?.trimEnd() ?? '';
      if (rawLogs.length > 0) {
        const lines = rawLogs.split('\n').slice(-20);
        console.log('Last logs:');
        console.log(lines.join('\n'));
      } else {
        console.log('Last logs: none');
      }

      const runDir = getRunDir(taskId);
      let attempts: string[] = [];
      if (existsSync(runDir)) {
        const entries = readdirSync(runDir, { withFileTypes: true });
        attempts = entries
          .filter((e) => e.isDirectory() && /^attempt-\d+$/.test(e.name))
          .map((e) => e.name)
          .sort((a, b) => {
            const numA = parseInt(a.replace('attempt-', ''), 10);
            const numB = parseInt(b.replace('attempt-', ''), 10);
            return numA - numB;
          });
      }

      if (attempts.length > 0) {
        console.log('Attempts:');
        for (const attempt of attempts) {
          console.log(`  - ${attempt}`);
        }
      } else {
        console.log('Attempts: none');
      }
    }
    process.exit(0);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[status] Error: ${message}`);
    process.exit(1);
  }
}

if (command === 'git-check') {
  try {
    const task = loadTask(getTasksFilePath(), taskId);
    const exists = branchExists(task.repo_path, task.work_branch);
    ensureClean(task.repo_path);
    const current = getCurrentBranch(task.repo_path);

    console.log(`[git-check] Task: ${taskId}`);
    console.log(`[git-check] Repo: ${task.repo_path}`);
    console.log(`[git-check] Current branch: ${current}`);
    console.log(
      `[git-check] Work branch "${task.work_branch}" exists: ${exists}`
    );
    console.log(`[git-check] Clean: true`);
    process.exit(0);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[git-check] Error: ${message}`);
    process.exit(1);
  }
}

if (command === 'git-diff') {
  try {
    const task = loadTask(getTasksFilePath(), taskId);
    const changed = getChangedFiles(task.repo_path);
    const stat = getDiffStat(task.repo_path);

    console.log(`[git-diff] Task: ${taskId}`);
    console.log(`[git-diff] Changed files: ${changed.length}`);
    console.log(`[git-diff] Insertions: ${stat.insertions}`);
    console.log(`[git-diff] Deletions: ${stat.deletions}`);
    console.log(`[git-diff] Binary files: ${stat.binaryFiles.length}`);
    process.exit(0);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[git-diff] Error: ${message}`);
    process.exit(1);
  }
}

if (command === 'mock-apply') {
  const jsonPath = args[2];
  if (!jsonPath) {
    console.error('Usage: npx tsx src/cli.ts mock-apply <taskId> <jsonPath>');
    process.exit(1);
  }
  try {
    if (!existsSync(jsonPath)) {
      throw new Error(`jsonPath does not exist: ${jsonPath}`);
    }
    const stats = statSync(jsonPath);
    if (!stats.isFile()) {
      throw new Error(`jsonPath is not a file: ${jsonPath}`);
    }

    const task = loadTask(getTasksFilePath(), taskId);
    const rawJson = readFileSync(jsonPath, 'utf-8');
    const result = runMockApplyFlow(task, rawJson);

    if (result.success) {
      console.log('[mock-apply] Success');
      console.log(result.logs);
      process.exit(0);
    } else {
      console.error('[mock-apply] Failed');
      console.error(result.logs);
      process.exit(1);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[mock-apply] Error: ${message}`);
    process.exit(1);
  }
}

if (command === 'run') {
  try {
    const task = loadTask(getTasksFilePath(), taskId);
    let state = loadState(taskId);

    if (!state) {
      state = initState(task);
      saveState(taskId, state);
      console.log(`[run] Initialized new state for task "${taskId}"`);
    } else {
      console.log(`[run] Existing state found for task "${taskId}"`);
    }

    console.log('[run] Current state:\n');
    console.log(JSON.stringify(state, null, 2));

    const context = buildContext(task);
    console.log(`\n[run] Context files: ${context.files.length}`);
    for (const f of context.files) {
      console.log(`  - ${f.path}`);
    }

    const guardrailsResult = validateFileList(
      task.context_files,
      task.guardrails
    );
    if (!guardrailsResult.ok) {
      console.error(`\n[run] Guardrails context file check: failed`);
      console.error(`[run] ${guardrailsResult.reason}`);
      process.exit(1);
    }
    console.log(`[run] Guardrails context file check: ok`);

    const checkResult = runChecks(task.repo_path, task.checks);
    if (!checkResult.success) {
      console.error(`\n[run] Checks: failed`);
      console.error(
        `[run] Failed command: ${checkResult.failedStep?.command} ${checkResult.failedStep?.args?.join(' ')}`
      );
      console.error(`[run] Logs:\n${checkResult.logs}`);
      process.exit(1);
    }
    console.log(`[run] Checks: ok`);

    process.exit(0);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[run] Error: ${message}`);
    process.exit(1);
  }
}

if (command === 'attempt') {
  const attemptArg = args[2];
  if (!attemptArg) {
    console.error('Usage: npx tsx src/cli.ts attempt <taskId> <attemptNumber>');
    process.exit(1);
  }
  if (!/^[1-9]\d*$/.test(attemptArg)) {
    console.error(`[attempt] Invalid attempt number: ${attemptArg}`);
    process.exit(1);
  }
  const attemptNumber = Number(attemptArg);

  try {
    const attemptDir = join(getRunDir(taskId), `attempt-${attemptNumber}`);
    if (!existsSync(attemptDir)) {
      console.error(`[attempt] Not found: attempt-${attemptNumber}`);
      process.exit(1);
    }
    const attemptStats = statSync(attemptDir);
    if (!attemptStats.isDirectory()) {
      console.error(`[attempt] Not found: attempt-${attemptNumber}`);
      process.exit(1);
    }

    console.log(`[attempt] Task: ${taskId}`);
    console.log(`[attempt] Attempt: attempt-${attemptNumber}`);

    const entries = readdirSync(attemptDir, { withFileTypes: true });
    const files = entries.filter((e) => e.isFile()).map((e) => e.name);

    const priority = [
      'raw-kimi-output.json',
      'parsed-kimi-output.json',
      'patch-manifest.json',
      'logs.txt',
    ];
    const sorted = files.sort((a, b) => {
      const idxA = priority.indexOf(a);
      const idxB = priority.indexOf(b);
      if (idxA !== -1 && idxB !== -1) return idxA - idxB;
      if (idxA !== -1) return -1;
      if (idxB !== -1) return 1;
      return a.localeCompare(b);
    });

    if (sorted.length > 0) {
      console.log('Files:');
      for (const file of sorted) {
        console.log(`  - ${file}`);
      }
    } else {
      console.log('Files: none');
    }

    const logsPath = join(attemptDir, 'logs.txt');
    if (existsSync(logsPath)) {
      const rawLogs = readFileSync(logsPath, 'utf-8').trimEnd();
      if (rawLogs.length > 0) {
        const lines = rawLogs.split('\n').slice(-40);
        console.log('Last logs:');
        console.log(lines.join('\n'));
      }
    }

    process.exit(0);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[attempt] Error: ${message}`);
    process.exit(1);
  }
}

if (command === 'context') {
  try {
    const task = loadTask(getTasksFilePath(), taskId);
    const context = buildContext(task);

    const runDir = getRunDir(taskId);
    if (!existsSync(runDir)) {
      mkdirSync(runDir, { recursive: true });
    }
    const outPath = join(runDir, 'context-package.json');
    writeFileSync(outPath, JSON.stringify(context, null, 2), 'utf-8');

    console.log(`[context] Task: ${taskId}`);
    console.log(`[context] Files: ${context.files.length}`);
    console.log(`[context] Written: ${outPath}`);
    process.exit(0);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[context] Error: ${message}`);
    process.exit(1);
  }
}

if (command === 'prompt') {
  try {
    const task = loadTask(getTasksFilePath(), taskId);
    const context = buildContext(task);

    const runDir = getRunDir(taskId);
    if (!existsSync(runDir)) {
      mkdirSync(runDir, { recursive: true });
    }

    const contextPath = join(runDir, 'context-package.json');
    writeFileSync(contextPath, JSON.stringify(context, null, 2), 'utf-8');

    const promptPath = join(runDir, 'kimi-prompt.md');
    const prompt = buildKimiPrompt(context);

    writeFileSync(promptPath, prompt, 'utf-8');

    console.log(`[prompt] Task: ${taskId}`);
    console.log(`[prompt] Files: ${context.files.length}`);
    console.log(`[prompt] Written: ${promptPath}`);
    process.exit(0);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[prompt] Error: ${message}`);
    process.exit(1);
  }
}

if (command === 'validate-output') {
  const jsonPath = args[2];
  if (!jsonPath) {
    console.error('Usage: npx tsx src/cli.ts validate-output <taskId> <jsonPath>');
    process.exit(1);
  }
  try {
    if (!existsSync(jsonPath)) {
      throw new Error(`jsonPath does not exist: ${jsonPath}`);
    }
    const stats = statSync(jsonPath);
    if (!stats.isFile()) {
      throw new Error(`jsonPath is not a file: ${jsonPath}`);
    }

    const rawJson = readFileSync(jsonPath, 'utf-8');
    const kimiOutput = validateKimiOutputForTask(rawJson, taskId);

    console.log(`[validate-output] Task: ${taskId}`);
    console.log('[validate-output] Valid Kimi output');
    console.log(`[validate-output] Files: ${kimiOutput.files.length}`);
    for (const file of kimiOutput.files) {
      console.log(`  - ${file.path}`);
    }
    console.log('[validate-output] Guardrails: ok');
    process.exit(0);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.startsWith('Guardrails failed:')) {
      console.error(`[validate-output] ${message}`);
    } else {
      console.error(`[validate-output] Error: ${message}`);
    }
    process.exit(1);
  }
}

if (command === 'ai-generate') {
  try {
    const allowRealAI = args.includes('--allow-real-ai');
    const result = await executeAiGenerate(taskId, allowRealAI);
    console.log(`[ai-generate] Task: ${taskId}`);
    console.log(`[ai-generate] Provider: ${config.ai.provider}`);
    console.log(`[ai-generate] Written: ${result.outputPath}`);
    if (result.backupPath) {
      console.log(`[ai-generate] Backup: ${result.backupPath}`);
    }
    process.exitCode = 0;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[ai-generate] Error: ${message}`);
    process.exit(1);
  }
}

if (command === 'ai-validate') {
  try {
    const kimiOutput = executeAiValidate(taskId);

    console.log(`[ai-validate] Task: ${taskId}`);
    console.log('[ai-validate] Valid AI output');
    console.log(`[ai-validate] Files: ${kimiOutput.files.length}`);
    if (kimiOutput.files.length === 0) {
      console.log('[ai-validate] No file changes proposed');
      if (kimiOutput.notes) {
        console.log(`[ai-validate] Notes: ${kimiOutput.notes}`);
      }
      console.log('[ai-validate] Guardrails: ok');
      process.exit(0);
    }
    for (const file of kimiOutput.files) {
      console.log(`  - ${file.path}`);
    }
    console.log('[ai-validate] Guardrails: ok');
    process.exit(0);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.startsWith('Guardrails failed:')) {
      console.error(`[ai-validate] ${message}`);
    } else {
      console.error(`[ai-validate] Error: ${message}`);
    }
    process.exit(1);
  }
}

if (command === 'ai-preview') {
  try {
    console.log(`[ai-preview] Task: ${taskId}`);
    const previewResult = executeAiPreview(taskId);
    console.log(`[ai-preview] Files: ${previewResult.filesCount}`);
    if (previewResult.filesCount === 0) {
      console.log('[ai-preview] No file changes proposed');
      if (previewResult.notes) {
        console.log(`[ai-preview] Notes: ${previewResult.notes}`);
      }
    }
    process.exitCode = 0;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.startsWith('Guardrails failed:')) {
      console.error(`[ai-preview] ${message}`);
    } else {
      console.error(`[ai-preview] Error: ${message}`);
    }
    process.exit(1);
  }
}

if (command === 'ai-run') {
  try {
    const allowRealAI = args.includes('--allow-real-ai');
    console.log(`[ai-run] Task: ${taskId}`);

    console.log(`[ai-run] Step 1/3: ai-generate`);
    const generateResult = await executeAiGenerate(taskId, allowRealAI);
    console.log(`[ai-run] ai-generate: ok`);
    if (generateResult.backupPath) {
      console.log(`[ai-run] Backup: ${generateResult.backupPath}`);
    }

    console.log(`[ai-run] Step 2/3: ai-validate`);
    executeAiValidate(taskId);
    console.log(`[ai-run] ai-validate: ok`);

    console.log(`[ai-run] Step 3/3: ai-preview`);
    const previewResult = executeAiPreview(taskId);
    if (previewResult.filesCount === 0) {
      console.log('[ai-run] No file changes proposed');
      if (previewResult.notes) {
        console.log(`[ai-run] Notes: ${previewResult.notes}`);
      }
    }
    console.log(`[ai-run] ai-preview: ok`);

    console.log(`[ai-run] Done. Review preview output, then run ai-apply manually if acceptable.`);
    process.exitCode = 0;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[ai-run] Error: ${message}`);
    process.exit(1);
  }
}

if (command === 'ai-apply') {
  try {
    const outputPath = join(getRunDir(taskId), 'ai-output.json');
    if (!existsSync(outputPath)) {
      console.error(
        '[ai-apply] Error: ai-output.json not found. Run ai-generate first.'
      );
      process.exit(1);
    }
    const stats = statSync(outputPath);
    if (!stats.isFile()) {
      console.error('[ai-apply] Error: ai-output.json is not a file');
      process.exit(1);
    }

    const raw = readFileSync(outputPath, 'utf-8');
    const kimiOutput = validateKimiOutputForTask(raw, taskId);

    if (kimiOutput.files.length === 0) {
      console.log('[ai-apply] No file changes proposed');
      if (kimiOutput.notes) {
        console.log(`[ai-apply] Notes: ${kimiOutput.notes}`);
      }
      process.exit(0);
    }

    const task = loadTask(getTasksFilePath(), taskId);
    const result = runMockApplyFlow(task, raw);

    if (result.success) {
      console.log('[ai-apply] Success');
      console.log(result.logs);
      process.exit(0);
    } else {
      console.error('[ai-apply] Failed');
      console.error(result.logs);
      process.exit(1);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.startsWith('Guardrails failed:')) {
      console.error(`[ai-apply] ${message}`);
    } else {
      console.error(`[ai-apply] Error: ${message}`);
    }
    process.exit(1);
  }
}

if (command === 'ai-output-status') {
  try {
    const runDir = getRunDir(taskId);
    const outPath = join(runDir, 'ai-output.json');
    const displayPath = `runs/${taskId}/ai-output.json`;

    console.log(`[ai-output-status] Task: ${taskId}`);

    let backups: string[] = [];
    if (existsSync(runDir)) {
      backups = readdirSync(runDir)
        .filter((f) => f.startsWith('ai-output.backup-') && f.endsWith('.json'))
        .sort((a, b) => a.localeCompare(b));
    }

    if (!existsSync(outPath)) {
      console.log('[ai-output-status] Output: missing');
      console.log(`[ai-output-status] Path: ${displayPath}`);
      console.log(`[ai-output-status] Backups: ${backups.length}`);
      if (backups.length > 0) {
        for (const b of backups) {
          console.log(`  - ${b}`);
        }
      }
      process.exit(1);
    }

    const raw = readFileSync(outPath, 'utf-8');
    console.log('[ai-output-status] Output: present');
    console.log(`[ai-output-status] Path: ${displayPath}`);

    let kimiOutput: KimiOutput | undefined;
    let errorMessage: string | undefined;
    try {
      kimiOutput = parseKimiOutputJson(raw);
    } catch (err) {
      errorMessage = err instanceof Error ? err.message : String(err);
    }

    if (kimiOutput) {
      console.log('[ai-output-status] Valid: yes');
      console.log(`[ai-output-status] Files: ${kimiOutput.files.length}`);
      if (kimiOutput.files.length > 0) {
        console.log('[ai-output-status] Paths:');
        for (const file of kimiOutput.files) {
          console.log(`  - ${file.path}`);
        }
      }
      if (kimiOutput.notes) {
        console.log(`[ai-output-status] Notes: ${kimiOutput.notes}`);
      }
    } else {
      console.log('[ai-output-status] Valid: no');
      console.log(`[ai-output-status] Error: ${errorMessage}`);
    }

    console.log(`[ai-output-status] Backups: ${backups.length}`);
    if (backups.length > 0) {
      for (const b of backups) {
        console.log(`  - ${b}`);
      }
    }

    process.exitCode = kimiOutput ? 0 : 1;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[ai-output-status] Error: ${message}`);
    process.exit(1);
  }
}

if (command === 'agent-once') {
  const extra = args.slice(2);
  let mode: AgentPlanMode;
  try {
    ({ mode } = parseAgentOnceArgs(extra));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[agent-once] Error: ${message}`);
    process.exit(1);
  }
  const plan = buildAgentPlan(taskId, mode);
  console.log(`[agent-once] Task: ${plan.taskId}`);
  console.log(`[agent-once] Mode: ${plan.mode}`);
  console.log(`[agent-once] Status: ${plan.status}`);
  console.log('[agent-once] Steps:');
  for (let i = 0; i < plan.steps.length; i++) {
    console.log(`  ${i + 1}. ${plan.steps[i]}`);
  }
  console.log(`[agent-once] ${plan.message}`);
  process.exitCode = 0;
}

if (command === 'pipeline-loop') {
  try {
    const mockAiResponse = process.env.MOCK_AI_RESPONSE;
    const mockReviewerResponse = process.env.MOCK_REVIEWER_RESPONSE;

    if (!mockAiResponse) {
      console.error('[pipeline-loop] Error: MOCK_AI_RESPONSE env var is required');
      process.exit(1);
    }
    if (!mockReviewerResponse) {
      console.error('[pipeline-loop] Error: MOCK_REVIEWER_RESPONSE env var is required');
      process.exit(1);
    }

    const task = loadTask(getTasksFilePath(), taskId);
    const result = runPipelineLoop(task, mockAiResponse, mockReviewerResponse);

    if (result.success) {
      console.log('[pipeline-loop] Success');
      console.log(result.logs);
      process.exit(0);
    } else {
      console.error('[pipeline-loop] Failed');
      console.error(result.logs);
      process.exit(1);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[pipeline-loop] Error: ${message}`);
    process.exit(1);
  }
}

if (command === 'real-provider-run') {
  try {
    const allowRealProvider = process.env.ALLOW_REAL_PROVIDER_RUN;

    if (allowRealProvider !== 'true') {
      console.error('[real-provider-run] Error: real-provider execution requires ALLOW_REAL_PROVIDER_RUN=true');
      console.error('[real-provider-run] No API call was made');
      console.error('[real-provider-run] No patch was applied');
      console.error('[real-provider-run] No push / no merge / no main touch');
      process.exit(1);
    }

    // Validate task exists before refusing (contracts check)
    loadTask(getTasksFilePath(), taskId);

    // Even with opt-in, execution is not implemented yet
    console.error('[real-provider-run] Error: real-provider execution is not implemented yet');
    console.error('[real-provider-run] No API call was made');
    console.error('[real-provider-run] No patch was applied');
    console.error('[real-provider-run] No push / no merge / no main touch');
    process.exit(1);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[real-provider-run] Error: ${message}`);
    process.exit(1);
  }
}

if (command === 'real-provider-plan') {
  try {
    const task = loadTask(getTasksFilePath(), taskId);

    console.log(`[real-provider-plan] Task: ${taskId}`);
    console.log(`[real-provider-plan] Repo path: ${task.repo_path}`);
    console.log(`[real-provider-plan] Base branch: ${task.base_branch}`);
    console.log(`[real-provider-plan] Work branch: ${task.work_branch}`);
    console.log(`[real-provider-plan] Checks count: ${task.checks.length}`);
    console.log(`[real-provider-plan] Max attempts: ${config.maxAttempts}`);
    console.log('[real-provider-plan] ---');
    console.log('[real-provider-plan] WARNING: No real API call was made.');
    console.log('[real-provider-plan] WARNING: No patch was applied.');
    console.log('[real-provider-plan] WARNING: No push, no merge, no main branch touch.');
    console.log('[real-provider-plan] This is a planning dry-run only.');

    process.exit(0);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[real-provider-plan] Error: ${message}`);
    process.exit(1);
  }
}

if (command === 'real-provider-preview') {
  try {
    if (process.env.ALLOW_REAL_PROVIDER_RUN !== 'true') {
      console.error('[real-provider-preview] Error: real provider preview requires ALLOW_REAL_PROVIDER_RUN=true');
      console.error('[real-provider-preview] No API call was made');
      console.error('[real-provider-preview] No patch was applied');
      console.error('[real-provider-preview] No git mutation was performed');
      console.error('[real-provider-preview] No state mutation was performed');
      process.exit(1);
    }

    const apiKey = process.env.KIMI_API_KEY?.trim();
    if (!apiKey) {
      console.error('[real-provider-preview] Error: KIMI_API_KEY env var is required');
      console.error('[real-provider-preview] No API call was made');
      console.error('[real-provider-preview] No patch was applied');
      console.error('[real-provider-preview] No git mutation was performed');
      console.error('[real-provider-preview] No state mutation was performed');
      process.exit(1);
    }

    const baseUrl = process.env.KIMI_BASE_URL?.trim();
    if (!baseUrl) {
      console.error('[real-provider-preview] Error: KIMI_BASE_URL env var is required');
      console.error('[real-provider-preview] No API call was made');
      console.error('[real-provider-preview] No patch was applied');
      console.error('[real-provider-preview] No git mutation was performed');
      console.error('[real-provider-preview] No state mutation was performed');
      process.exit(1);
    }

    const model = process.env.KIMI_MODEL?.trim() || 'kimi-k2.6';

    const fakeResponse = process.env.KIMI_FAKE_RESPONSE;
    let fetchFn: FetchFn;
    if (fakeResponse !== undefined) {
      fetchFn = async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: { content: fakeResponse } }],
        }),
      });
    } else {
      if (typeof globalThis.fetch !== 'function') {
        console.error('[real-provider-preview] Error: global fetch is not available');
        console.error('[real-provider-preview] No API call was made');
        console.error('[real-provider-preview] No patch was applied');
        console.error('[real-provider-preview] No git mutation was performed');
        console.error('[real-provider-preview] No state mutation was performed');
        process.exit(1);
      }
      fetchFn = globalThis.fetch as unknown as FetchFn;
    }

    const task = loadTask(getTasksFilePath(), taskId);
    const context = buildContext(task);
    const prompt = buildKimiPrompt(context);

    const realProviderCall = createRealProviderCall({
      provider: 'kimi',
      apiKey,
      baseUrl,
      fetchFn,
      model,
      userAgent: process.env.KIMI_USER_AGENT?.trim(),
    });

    const providerInput = buildProviderCallInput('coder', prompt, 'kimi', model);
    const result = await realProviderCall(providerInput);
    const normalizedResult = normalizeProviderCallResult(result);

    console.log(`[real-provider-preview] Task: ${taskId}`);
    console.log(`[real-provider-preview] Provider: ${normalizedResult.provider}`);
    console.log(`[real-provider-preview] Model: ${normalizedResult.model}`);
    console.log(`[real-provider-preview] Role: ${normalizedResult.role}`);
    console.log(`[real-provider-preview] Response:`);
    console.log(normalizedResult.text);
    console.log('[real-provider-preview] ---');

    // Parse-only section: validate output without applying patches
    let parsed: KimiOutput;
    try {
      parsed = parseKimiOutputJson(normalizedResult.text);
    } catch (parseErr) {
      const info = normalizeProviderCallError(parseErr);
      console.error(`[real-provider-preview] Error: ${info.message}`);
      console.error('[real-provider-preview] No patch was applied');
      console.error('[real-provider-preview] No git mutation was performed');
      console.error('[real-provider-preview] No state mutation was performed');
      process.exit(1);
    }

    const fileListValidation = validateFileList(
      parsed.files.map((f) => f.path),
      task.guardrails
    );
    if (!fileListValidation.ok) {
      console.error(`[real-provider-preview] Error: Guardrails: REJECTED — ${fileListValidation.reason}`);
      console.error('[real-provider-preview] No patch was applied');
      console.error('[real-provider-preview] No git mutation was performed');
      console.error('[real-provider-preview] No state mutation was performed');
      process.exit(1);
    }

    try {
      validateProposedFileLineDeltas(
        task.repo_path,
        parsed.files,
        task.guardrails.max_lines_changed
      );
    } catch (deltaErr) {
      const info = normalizeProviderCallError(deltaErr);
      console.error(`[real-provider-preview] Error: Guardrails: REJECTED — ${info.message}`);
      console.error('[real-provider-preview] No patch was applied');
      console.error('[real-provider-preview] No git mutation was performed');
      console.error('[real-provider-preview] No state mutation was performed');
      process.exit(1);
    }

    console.log('[real-provider-preview] Parse: PASS');
    console.log(`[real-provider-preview] Proposed files: ${parsed.files.length}`);
    for (const file of parsed.files) {
      const filePath = join(task.repo_path, file.path);
      const currentLines = existsSync(filePath) ? countLines(readFileSync(filePath, 'utf-8')) : 0;
      const proposedLines = countLines(file.content);
      const delta = proposedLines - currentLines;
      const deltaStr = delta >= 0 ? `+${delta}` : `${delta}`;
      const newTag = currentLines === 0 ? ' [new]' : '';
      console.log(`[real-provider-preview]   ${file.path}: ${currentLines} lines → ${proposedLines} lines (${deltaStr})${newTag}`);
    }
    console.log('[real-provider-preview] Guardrails: PASS');
    console.log('[real-provider-preview] No patch was applied');
    console.log('[real-provider-preview] No git mutation was performed');
    console.log('[real-provider-preview] No state mutation was performed');

    process.exit(0);
  } catch (err) {
    const info = normalizeProviderCallError(err);
    console.error(`[real-provider-preview] Error: ${info.message}`);
    console.error('[real-provider-preview] No patch was applied');
    console.error('[real-provider-preview] No git mutation was performed');
    console.error('[real-provider-preview] No state mutation was performed');
    process.exit(1);
  }
}

if (command === 'provider-preview') {
  try {
    const mockResponse = process.env.MOCK_PROVIDER_RESPONSE;
    if (!mockResponse) {
      console.error('[provider-preview] Error: MOCK_PROVIDER_RESPONSE env var is required');
      console.error('[provider-preview] No real API call was made');
      console.error('[provider-preview] No patch was applied');
      console.error('[provider-preview] No git mutation was performed');
      process.exit(1);
    }

    const extraArgs = args.slice(2);
    let role: string = 'coder';
    if (extraArgs.length === 2 && extraArgs[0] === '--role') {
      if (extraArgs[1] === 'coder' || extraArgs[1] === 'reviewer') {
        role = extraArgs[1];
      } else {
        console.error('[provider-preview] Error: Invalid role: expected coder or reviewer');
        console.error('[provider-preview] No real API call was made');
        console.error('[provider-preview] No patch was applied');
        console.error('[provider-preview] No git mutation was performed');
        process.exit(1);
      }
    } else if (extraArgs.length > 0) {
      console.error('[provider-preview] Error: Unexpected arguments. Usage: provider-preview <taskId> [--role coder|reviewer]');
      console.error('[provider-preview] No real API call was made');
      console.error('[provider-preview] No patch was applied');
      console.error('[provider-preview] No git mutation was performed');
      process.exit(1);
    }

    const task = loadTask(getTasksFilePath(), taskId);
    const context = buildContext(task);
    const prompt = buildKimiPrompt(context);

    const mockProviderCall = createMockProviderCall(mockResponse);
    const providerInput = buildProviderCallInput(role, prompt, 'mock', 'mock-model');
    const result = await mockProviderCall(providerInput);
    const normalizedResult = normalizeProviderCallResult(result);

    console.log(`[provider-preview] Task: ${taskId}`);
    console.log(`[provider-preview] Provider: ${normalizedResult.provider}`);
    console.log(`[provider-preview] Model: ${normalizedResult.model}`);
    console.log(`[provider-preview] Role: ${normalizedResult.role}`);
    console.log(`[provider-preview] Response:`);
    console.log(normalizedResult.text);
    console.log('[provider-preview] ---');
    console.log('[provider-preview] No real API call was made');
    console.log('[provider-preview] No patch was applied');
    console.log('[provider-preview] No git mutation was performed');

    process.exit(0);
  } catch (err) {
    const info = normalizeProviderCallError(err);
    console.error(`[provider-preview] Error: ${info.message}`);
    console.error('[provider-preview] No real API call was made');
    console.error('[provider-preview] No patch was applied');
    console.error('[provider-preview] No git mutation was performed');
    process.exit(1);
  }
}

if (command === 'sandbox-apply-preview') {
  try {
    if (process.env.ALLOW_SANDBOX_APPLY_PREVIEW !== 'true') {
      console.error('[sandbox-apply-preview] Error: sandbox-apply-preview requires ALLOW_SANDBOX_APPLY_PREVIEW=true');
      console.error('[sandbox-apply-preview] No patch was applied to real repo');
      console.error('[sandbox-apply-preview] No git mutation was performed in real repo');
      console.error('[sandbox-apply-preview] No state mutation was performed');
      process.exit(1);
    }

    const rawProviderText = process.env.SANDBOX_PROVIDER_RESPONSE?.trim();
    if (!rawProviderText) {
      console.error('[sandbox-apply-preview] Error: SANDBOX_PROVIDER_RESPONSE env var is required');
      console.error('[sandbox-apply-preview] No patch was applied to real repo');
      console.error('[sandbox-apply-preview] No git mutation was performed in real repo');
      console.error('[sandbox-apply-preview] No state mutation was performed');
      process.exit(1);
    }

    const sandboxRoot = process.env.SANDBOX_ROOT?.trim();
    if (!sandboxRoot) {
      console.error('[sandbox-apply-preview] Error: SANDBOX_ROOT env var is required');
      console.error('[sandbox-apply-preview] No patch was applied to real repo');
      console.error('[sandbox-apply-preview] No git mutation was performed in real repo');
      console.error('[sandbox-apply-preview] No state mutation was performed');
      process.exit(1);
    }

    const task = loadTask(getTasksFilePath(), taskId);
    const result = runSandboxApplyFlow({ task, rawProviderText, sandboxRoot });

    if (result.success) {
      console.log('[sandbox-apply-preview] Apply: PASS');
      console.log(`[sandbox-apply-preview] Applied files: ${result.appliedFiles?.join(', ') ?? 'none'}`);
      console.log(`[sandbox-apply-preview] Checks passed: ${result.checksPassed ? 'yes' : 'no'}`);
      console.log('[sandbox-apply-preview] Logs:');
      console.log(result.logs);
      console.log('[sandbox-apply-preview] No patch was applied to real repo');
      console.log('[sandbox-apply-preview] No git mutation was performed in real repo');
      console.log('[sandbox-apply-preview] No state mutation was performed');
      process.exit(0);
    } else {
      console.error('[sandbox-apply-preview] Apply: FAILED');
      console.error(`[sandbox-apply-preview] Failed step: ${result.failedStep ?? 'unknown'}`);
      console.error('[sandbox-apply-preview] Logs:');
      console.error(result.logs);
      console.error('[sandbox-apply-preview] No patch was applied to real repo');
      console.error('[sandbox-apply-preview] No git mutation was performed in real repo');
      console.error('[sandbox-apply-preview] No state mutation was performed');
      process.exit(1);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[sandbox-apply-preview] Error: ${message}`);
    console.error('[sandbox-apply-preview] No patch was applied to real repo');
    console.error('[sandbox-apply-preview] No git mutation was performed in real repo');
    console.error('[sandbox-apply-preview] No state mutation was performed');
    process.exit(1);
  }
}

if (command === 'real-repo-apply-dry-run') {
  try {
    const rawProviderText = process.env.REAL_REPO_PROVIDER_RESPONSE?.trim();
    if (!rawProviderText) {
      console.error('[real-repo-apply-dry-run] Error: REAL_REPO_PROVIDER_RESPONSE env var is required');
      console.error('[real-repo-apply-dry-run] No files were modified');
      console.error('[real-repo-apply-dry-run] No commit was made');
      console.error('[real-repo-apply-dry-run] No push was performed');
      console.error('[real-repo-apply-dry-run] No merge was performed');
      process.exit(1);
    }

    const task = loadTask(getTasksFilePath(), taskId);
    const kimiOutput = parseKimiOutputJson(rawProviderText);
    const updatePaths = kimiOutput.files.map((f) => f.path);

    const guardrailsResult = validateFileList(updatePaths, task.guardrails);
    if (!guardrailsResult.ok) {
      console.error(`[real-repo-apply-dry-run] Guardrails failed: ${guardrailsResult.reason}`);
      console.error('[real-repo-apply-dry-run] No files were modified');
      console.error('[real-repo-apply-dry-run] No commit was made');
      console.error('[real-repo-apply-dry-run] No push was performed');
      console.error('[real-repo-apply-dry-run] No merge was performed');
      process.exit(1);
    }

    if (task.guardrails.max_lines_changed !== undefined) {
      validateProposedFileLineDeltas(
        task.repo_path,
        kimiOutput.files,
        task.guardrails.max_lines_changed
      );
    }

    let currentBranch = '';
    let isClean = false;
    try {
      ensureClean(task.repo_path);
      isClean = true;
    } catch {
      isClean = false;
    }

    try {
      currentBranch = getCurrentBranch(task.repo_path);
    } catch {
      currentBranch = '';
    }

    const safetyResult = validateRealRepoApplySafety(task, { isClean, currentBranch });
    if (!safetyResult.ok) {
      console.error(`[real-repo-apply-dry-run] Safety check failed: ${safetyResult.reason}`);
      console.error('[real-repo-apply-dry-run] No files were modified');
      console.error('[real-repo-apply-dry-run] No commit was made');
      console.error('[real-repo-apply-dry-run] No push was performed');
      console.error('[real-repo-apply-dry-run] No merge was performed');
      process.exit(1);
    }

    const lineDeltas = kimiOutput.files.map((f) => {
      const filePath = join(task.repo_path, f.path);
      const fileExists = existsSync(filePath);
      const oldContent = fileExists ? readFileSync(filePath, 'utf-8') : '';
      const oldLines = countLines(oldContent);
      const newLines = countLines(f.content);
      return { path: f.path, lineDelta: newLines - oldLines, isNew: !fileExists };
    });

    const summary = buildRealRepoApplyDryRunSummary({
      taskId,
      currentBranch,
      workBranch: task.work_branch,
      guardrailsVerdict: 'PASS',
      safetyVerdict: 'PASS',
      files: lineDeltas,
    });

    console.log(`[real-repo-apply-dry-run] Task: ${summary.taskId}`);
    console.log(`[real-repo-apply-dry-run] Current branch: ${summary.currentBranch}`);
    console.log(`[real-repo-apply-dry-run] Work branch: ${summary.workBranch}`);
    console.log(`[real-repo-apply-dry-run] Guardrails: ${summary.guardrailsVerdict}`);
    console.log(`[real-repo-apply-dry-run] Safety: ${summary.safetyVerdict}`);
    console.log('[real-repo-apply-dry-run] Files:');
    for (const f of summary.files) {
      console.log(`[real-repo-apply-dry-run]   ${f.path}: delta=${f.lineDelta}, isNew=${f.isNew}`);
    }
    console.log('[real-repo-apply-dry-run] Safety messages:');
    for (const msg of summary.safetyMessages) {
      console.log(`[real-repo-apply-dry-run]   ${msg}`);
    }
    process.exit(0);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[real-repo-apply-dry-run] Error: ${message}`);
    console.error('[real-repo-apply-dry-run] No files were modified');
    console.error('[real-repo-apply-dry-run] No commit was made');
    console.error('[real-repo-apply-dry-run] No push was performed');
    console.error('[real-repo-apply-dry-run] No merge was performed');
    process.exit(1);
  }
}

if (command === 'real-repo-apply') {
  let applyStarted = false;
  try {
    if (process.env.ALLOW_REAL_REPO_APPLY !== 'true') {
      console.error('[real-repo-apply] ALLOW_REAL_REPO_APPLY=true is required');
      console.error('[real-repo-apply] No files were modified');
      console.error('[real-repo-apply] No commit was made');
      console.error('[real-repo-apply] No push was performed');
      console.error('[real-repo-apply] No merge was performed');
      process.exit(1);
    }

    const rawProviderText = process.env.REAL_REPO_PROVIDER_RESPONSE?.trim();
    if (!rawProviderText) {
      console.error('[real-repo-apply] Error: REAL_REPO_PROVIDER_RESPONSE env var is required');
      console.error('[real-repo-apply] No files were modified');
      console.error('[real-repo-apply] No commit was made');
      console.error('[real-repo-apply] No push was performed');
      console.error('[real-repo-apply] No merge was performed');
      process.exit(1);
    }

    const task = loadTask(getTasksFilePath(), taskId);
    const kimiOutput = parseKimiOutputJson(rawProviderText);
    const updatePaths = kimiOutput.files.map((f) => f.path);

    const guardrailsResult = validateFileList(updatePaths, task.guardrails);
    if (!guardrailsResult.ok) {
      console.error(`[real-repo-apply] Guardrails failed: ${guardrailsResult.reason}`);
      console.error('[real-repo-apply] No files were modified');
      console.error('[real-repo-apply] No commit was made');
      console.error('[real-repo-apply] No push was performed');
      console.error('[real-repo-apply] No merge was performed');
      process.exit(1);
    }

    if (task.guardrails.max_lines_changed !== undefined) {
      validateProposedFileLineDeltas(
        task.repo_path,
        kimiOutput.files,
        task.guardrails.max_lines_changed
      );
    }

    let currentBranch = '';
    let isClean = false;
    try {
      ensureClean(task.repo_path);
      isClean = true;
    } catch {
      isClean = false;
    }

    try {
      currentBranch = getCurrentBranch(task.repo_path);
    } catch {
      currentBranch = '';
    }

    const safetyResult = validateRealRepoApplySafety(task, { isClean, currentBranch });
    if (!safetyResult.ok) {
      console.error(`[real-repo-apply] Safety check failed: ${safetyResult.reason}`);
      console.error('[real-repo-apply] No files were modified');
      console.error('[real-repo-apply] No commit was made');
      console.error('[real-repo-apply] No push was performed');
      console.error('[real-repo-apply] No merge was performed');
      process.exit(1);
    }

    // Sandbox preflight gate
    const sandboxRootApply = mkdtempSync(join(tmpdir(), 'preflight-'));
    try {
      const preflightResult = runRealRepoSandboxPreflight({
        task,
        rawProviderText,
        sandboxRoot: sandboxRootApply,
      });
      if (!preflightResult.ok) {
        console.error(`[real-repo-apply] Sandbox preflight failed at step: ${preflightResult.failedStep}`);
        const summary = redactSecrets(preflightResult.logs).split('\n').slice(-5).join('\n');
        console.error(`[real-repo-apply] Sandbox logs (last 5 lines):\n${summary}`);
        console.error('[real-repo-apply] No files were modified');
        console.error('[real-repo-apply] No commit was made');
        console.error('[real-repo-apply] No push was performed');
        console.error('[real-repo-apply] No merge was performed');
        process.exit(1);
      }
    } finally {
      if (existsSync(sandboxRootApply)) {
        rmSync(sandboxRootApply, { recursive: true, force: true });
      }
    }

    const existingPaths: string[] = [];
    for (const f of kimiOutput.files) {
      const filePath = join(task.repo_path, f.path);
      if (existsSync(filePath)) {
        existingPaths.push(f.path);
      }
    }

    const planResult = buildRealRepoApplyPlan({
      taskId,
      attempt: 1,
      existingPaths,
      files: kimiOutput.files,
    });

    if (!planResult.ok) {
      console.error(`[real-repo-apply] Plan builder failed: ${planResult.reason}`);
      for (const msg of planResult.safetyMessages) {
        console.error(`[real-repo-apply] ${msg}`);
      }
      console.error('[real-repo-apply] No files were modified');
      console.error('[real-repo-apply] No commit was made');
      console.error('[real-repo-apply] No push was performed');
      console.error('[real-repo-apply] No merge was performed');
      process.exit(1);
    }

    console.log(`[real-repo-apply] Task: ${planResult.taskId}`);
    console.log(`[real-repo-apply] Current branch: ${currentBranch}`);
    console.log(`[real-repo-apply] Work branch: ${task.work_branch}`);
    console.log('[real-repo-apply] Files:');
    for (const f of planResult.files) {
      console.log(`[real-repo-apply]   ${f.path}: action=${f.action}, backupPath=${f.backupPath}`);
    }

    let manifest: import('./types.js').PatchManifestEntry[] | undefined;
    try {
      applyStarted = true;
      manifest = applyFileUpdates(task.repo_path, kimiOutput.files, planResult.runDir);
    } catch (applyErr) {
      const applyMessage = applyErr instanceof Error ? applyErr.message : String(applyErr);
      console.error(`[real-repo-apply] Apply failed: ${applyMessage}`);
      console.error('[real-repo-apply] Manual inspection required');
      console.error('[real-repo-apply] Rollback could not be attempted because apply manifest was not returned');
      console.error('[real-repo-apply] No commit was made');
      console.error('[real-repo-apply] No push was performed');
      console.error('[real-repo-apply] No merge was performed');
      process.exit(1);
    }

    const checkResult = runChecks(task.repo_path, task.checks);
    if (!checkResult.success) {
      console.error('[real-repo-apply] Checks failed');
      if (manifest && manifest.length > 0) {
        try {
          rollbackFileUpdates(task.repo_path, manifest);
          console.error('[real-repo-apply] Rollback completed');
        } catch (rollbackErr) {
          const rollbackMessage = rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr);
          console.error(`[real-repo-apply] Rollback failed: ${rollbackMessage}`);
        }
      } else {
        console.error('[real-repo-apply] Rollback could not be attempted because apply manifest was not returned');
      }
      console.error('[real-repo-apply] No commit was made');
      console.error('[real-repo-apply] No push was performed');
      console.error('[real-repo-apply] No merge was performed');
      process.exit(1);
    }

    console.log('[real-repo-apply] real-repo-apply completed local file apply');
    for (const f of planResult.files) {
      console.log(`[real-repo-apply]   ${f.path}`);
    }
    console.log('[real-repo-apply] No commit was made');
    console.log('[real-repo-apply] No push was performed');
    console.log('[real-repo-apply] No merge was performed');
    console.log('[real-repo-apply] Human review required before commit');
    process.exit(0);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[real-repo-apply] Error: ${message}`);
    if (applyStarted) {
      console.error('[real-repo-apply] Manual inspection required');
    } else {
      console.error('[real-repo-apply] No files were modified');
    }
    console.error('[real-repo-apply] No commit was made');
    console.error('[real-repo-apply] No push was performed');
    console.error('[real-repo-apply] No merge was performed');
    process.exit(1);
  }
}

if (command === 'reviewer-gate-dry-run') {
  try {
    if (!taskId) {
      console.error('[reviewer-gate-dry-run] Error: task id is required');
      console.error('[reviewer-gate-dry-run] No provider call was made');
      console.error('[reviewer-gate-dry-run] No merge was performed');
      console.error('[reviewer-gate-dry-run] No checkout was performed');
      console.error('[reviewer-gate-dry-run] No main touch was performed');
      process.exit(1);
    }

    const task = loadTask(getTasksFilePath(), taskId);

    // Build minimal ReviewInput from task
    const reviewInput = {
      task_id: taskId,
      task_title: task.title,
      task_goal: task.goal,
      allowed_files: task.guardrails.allow_modify ?? [],
      denied_files: task.guardrails.deny_modify,
      max_lines_changed: task.guardrails.max_lines_changed ?? 0,
      commit_sha: 'dry-run-commit-sha',
      changed_files: [],
      diff: '',
      typecheck_result: 'skipped (dry-run)',
      build_result: 'skipped (dry-run)',
      test_result: 'skipped (dry-run)',
      git_status: 'clean (dry-run)',
      safety_findings: ['dry-run: no real checks performed'],
    };

    // Resolve reviewer provider
    const reviewerProviderId = process.env.REVIEWER_PROVIDER?.trim() || 'fake';
    const registry = new ProviderRegistry();
    registry.registerReviewer('fake', () => createFakeReviewerProvider());
    registry.registerReviewer('kimi', () => {
      const fakeResponse = process.env.KIMI_FAKE_REVIEWER_RESPONSE;
      return createKimiReviewerProvider(
        {
          provider: 'kimi',
          model: process.env.KIMI_REVIEWER_MODEL?.trim() || process.env.KIMI_MODEL?.trim() || 'kimi-k2.6',
        },
        {
          allowReal: process.env.ALLOW_KIMI_REVIEWER === 'true',
          apiKey: process.env.KIMI_API_KEY?.trim(),
          baseUrl: process.env.KIMI_BASE_URL?.trim(),
          model: process.env.KIMI_REVIEWER_MODEL?.trim() || process.env.KIMI_MODEL?.trim(),
          userAgent: process.env.KIMI_USER_AGENT?.trim(),
          fakeResponse,
          fetchFn: fakeResponse !== undefined
            ? async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: fakeResponse } }] }) })
            : undefined,
        }
      );
    });

    let reviewer;
    try {
      reviewer = registry.resolveReviewer({ provider: reviewerProviderId as any, model: 'default' });
    } catch (resolveErr) {
      const msg = resolveErr instanceof Error ? resolveErr.message : String(resolveErr);
      console.error(`[reviewer-gate-dry-run] Error: ${msg}`);
      console.error('[reviewer-gate-dry-run] No provider call was made');
      console.error('[reviewer-gate-dry-run] No merge was performed');
      console.error('[reviewer-gate-dry-run] No checkout was performed');
      console.error('[reviewer-gate-dry-run] No main touch was performed');
      process.exit(1);
    }

    const decision = await reviewer.reviewCommit(reviewInput);

    // Validate decision schema
    const validated = validateReviewerDecision(decision);

    console.log(`[reviewer-gate-dry-run] Reviewer provider: ${reviewerProviderId}`);
    console.log(`[reviewer-gate-dry-run] Reviewer decision: ${validated.decision}`);
    console.log(`[reviewer-gate-dry-run] Confidence: ${validated.confidence}`);
    console.log(`[reviewer-gate-dry-run] Next action: ${validated.next_action}`);
    console.log(`[reviewer-gate-dry-run] Blocking issues count: ${validated.blocking_issues.length}`);
    console.log(`[reviewer-gate-dry-run] Non-blocking issues count: ${validated.non_blocking_issues.length}`);
    if (validated.review_summary) {
      console.log(`[reviewer-gate-dry-run] Review summary: ${validated.review_summary}`);
    }
    console.log('[reviewer-gate-dry-run] No file was modified');
    console.log('[reviewer-gate-dry-run] No git command was executed');
    console.log('[reviewer-gate-dry-run] No merge was performed');
    console.log('[reviewer-gate-dry-run] No checkout was performed');
    console.log('[reviewer-gate-dry-run] No main touch was performed');
    process.exit(0);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[reviewer-gate-dry-run] Error: ${message}`);
    console.error('[reviewer-gate-dry-run] No merge was performed');
    console.error('[reviewer-gate-dry-run] No checkout was performed');
    console.error('[reviewer-gate-dry-run] No main touch was performed');
    process.exit(1);
  }
}

if (command === 'reviewer-gate-evidence-dry-run') {
  try {
    if (!taskId) {
      console.error('[reviewer-gate-evidence-dry-run] Error: task id is required');
      console.error('[reviewer-gate-evidence-dry-run] No provider call was made');
      console.error('[reviewer-gate-evidence-dry-run] No merge was performed');
      console.error('[reviewer-gate-evidence-dry-run] No checkout was performed');
      console.error('[reviewer-gate-evidence-dry-run] No main touch was performed');
      process.exit(1);
    }
    if (!commitSha) {
      console.error('[reviewer-gate-evidence-dry-run] Error: commit SHA is required');
      console.error('[reviewer-gate-evidence-dry-run] No provider call was made');
      console.error('[reviewer-gate-evidence-dry-run] No merge was performed');
      console.error('[reviewer-gate-evidence-dry-run] No checkout was performed');
      console.error('[reviewer-gate-evidence-dry-run] No main touch was performed');
      process.exit(1);
    }

    // Validate commit SHA format before loading task
    validateCommitSha(commitSha);

    const task = loadTask(getTasksFilePath(), taskId);
    const repoPath = task.repo_path;

    // Build commit evidence
    const evidence = buildCommitEvidence({
      repoPath,
      taskId,
      taskGoal: task.goal,
      allowedFiles: task.guardrails.allow_modify ?? [],
      deniedFiles: task.guardrails.deny_modify,
      maxLinesChanged: task.guardrails.max_lines_changed ?? 0,
      commitSha,
      baseRef: task.base_branch,
    });

    // Determine check results: in dry-run mode we cannot run real typecheck/build/test
    // so we report them as skipped unless the caller provides env overrides
    const typecheckResult = process.env.DRY_RUN_TYPECHECK_RESULT?.trim() || 'skipped (dry-run)';
    const buildResult = process.env.DRY_RUN_BUILD_RESULT?.trim() || 'skipped (dry-run)';
    const testResult = process.env.DRY_RUN_TEST_RESULT?.trim() || 'skipped (dry-run)';

    // Run deterministic checks
    const deterministicResult = runDeterministicReviewChecks({
      allowedFiles: evidence.allowedFiles,
      deniedFiles: evidence.deniedFiles,
      maxLinesChanged: evidence.maxLinesChanged,
      changedFiles: evidence.changedFiles,
      diff: evidence.diff,
      typecheckResult,
      buildResult,
      testResult,
      gitStatus: evidence.gitStatus,
      commitSha: evidence.commitSha,
      currentBranch: evidence.currentBranch,
    });

    // Build ReviewInput
    const reviewInput = buildReviewInput({
      blockId: undefined,
      taskId: evidence.taskId,
      taskTitle: task.title,
      taskGoal: evidence.taskGoal,
      allowedFiles: evidence.allowedFiles,
      deniedFiles: evidence.deniedFiles,
      maxLinesChanged: evidence.maxLinesChanged,
      commitSha: evidence.commitSha,
      changedFiles: evidence.changedFiles,
      diff: evidence.diff,
      typecheckResult,
      buildResult,
      testResult,
      gitStatus: evidence.gitStatus,
      safetyFindings: [...evidence.safetyFindings, ...deterministicResult.safetyFindings],
    });

    // Resolve reviewer provider
    const reviewerProviderId = process.env.REVIEWER_PROVIDER?.trim() || 'fake';
    const registry = new ProviderRegistry();
    registry.registerReviewer('fake', () => createFakeReviewerProvider());
    registry.registerReviewer('kimi', () => {
      const fakeResponse = process.env.KIMI_FAKE_REVIEWER_RESPONSE;
      return createKimiReviewerProvider(
        {
          provider: 'kimi',
          model: process.env.KIMI_REVIEWER_MODEL?.trim() || process.env.KIMI_MODEL?.trim() || 'kimi-k2.6',
        },
        {
          allowReal: process.env.ALLOW_KIMI_REVIEWER === 'true',
          apiKey: process.env.KIMI_API_KEY?.trim(),
          baseUrl: process.env.KIMI_BASE_URL?.trim(),
          model: process.env.KIMI_REVIEWER_MODEL?.trim() || process.env.KIMI_MODEL?.trim(),
          userAgent: process.env.KIMI_USER_AGENT?.trim(),
          fakeResponse,
          fetchFn: fakeResponse !== undefined
            ? async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: fakeResponse } }] }) })
            : undefined,
        }
      );
    });

    let reviewer;
    try {
      reviewer = registry.resolveReviewer({ provider: reviewerProviderId as any, model: 'default' });
    } catch (resolveErr) {
      const msg = resolveErr instanceof Error ? resolveErr.message : String(resolveErr);
      console.error(`[reviewer-gate-evidence-dry-run] Error: ${msg}`);
      console.error('[reviewer-gate-evidence-dry-run] No provider call was made');
      console.error('[reviewer-gate-evidence-dry-run] No merge was performed');
      console.error('[reviewer-gate-evidence-dry-run] No checkout was performed');
      console.error('[reviewer-gate-evidence-dry-run] No main touch was performed');
      process.exit(1);
    }

    // Run reviewer gate
    const gateResult = await runReviewerGate({
      reviewer,
      reviewInput,
      deterministicResult,
    });

    console.log(`[reviewer-gate-evidence-dry-run] Commit: ${evidence.commitSha}`);
    console.log(`[reviewer-gate-evidence-dry-run] Current branch: ${evidence.currentBranch}`);
    console.log(`[reviewer-gate-evidence-dry-run] Changed files: ${evidence.changedFiles.length}`);
    console.log(`[reviewer-gate-evidence-dry-run] Deterministic checks: ${deterministicResult.ok ? 'PASS' : 'FAIL'}`);
    console.log(`[reviewer-gate-evidence-dry-run] Reviewer called: ${gateResult.reviewerCalled ? 'yes' : 'no'}`);
    console.log(`[reviewer-gate-evidence-dry-run] Reviewer decision: ${gateResult.decision.decision}`);
    console.log(`[reviewer-gate-evidence-dry-run] Next action: ${gateResult.decision.next_action}`);
    console.log(`[reviewer-gate-evidence-dry-run] Blocking issues count: ${gateResult.decision.blocking_issues.length}`);
    if (gateResult.decision.review_summary) {
      console.log(`[reviewer-gate-evidence-dry-run] Review summary: ${gateResult.decision.review_summary}`);
    }
    console.log('[reviewer-gate-evidence-dry-run] No file was modified');
    console.log('[reviewer-gate-evidence-dry-run] No state was written');
    console.log('[reviewer-gate-evidence-dry-run] No merge was performed');
    console.log('[reviewer-gate-evidence-dry-run] No checkout was performed');
    console.log('[reviewer-gate-evidence-dry-run] No main touch was performed');
    process.exit(0);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[reviewer-gate-evidence-dry-run] Error: ${message}`);
    console.error('[reviewer-gate-evidence-dry-run] No merge was performed');
    console.error('[reviewer-gate-evidence-dry-run] No checkout was performed');
    console.error('[reviewer-gate-evidence-dry-run] No main touch was performed');
    process.exit(1);
  }
}

if (command === 'block-init') {
  try {
    const blockJsonPath = taskId;
    if (!blockJsonPath) {
      console.error('[block-init] Error: block JSON path is required');
      process.exit(1);
    }

    const definition = loadBlockDefinition(blockJsonPath);
    const state = initBlockState(definition);
    saveBlockState(state);

    console.log(`[block-init] Block initialized: ${state.block_id}`);
    console.log(`[block-init] Title: ${state.title}`);
    console.log(`[block-init] Tasks: ${state.tasks.length}`);
    console.log(`[block-init] Current task: ${state.current_task_id ?? 'none'}`);
    console.log('[block-init] No provider call was made');
    console.log('[block-init] No git command was executed');
    console.log('[block-init] No merge was performed');
    console.log('[block-init] No checkout was performed');
    console.log('[block-init] No main touch was performed');
    process.exit(0);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[block-init] Error: ${message}`);
    console.error('[block-init] No merge was performed');
    console.error('[block-init] No checkout was performed');
    console.error('[block-init] No main touch was performed');
    process.exit(1);
  }
}

if (command === 'block-status') {
  try {
    const blockId = taskId;
    if (!blockId) {
      console.error('[block-status] Error: block id is required');
      process.exit(1);
    }

    const state = loadBlockState(blockId);
    if (!state) {
      console.error(`[block-status] Error: block state not found: ${blockId}`);
      process.exit(1);
    }

    const report = buildBlockStatusReport(state);
    console.log(report);
    process.exit(0);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[block-status] Error: ${message}`);
    process.exit(1);
  }
}

if (command === 'block-transition') {
  try {
    const blockId = taskId;
    const transitionTaskId = commitSha;
    const transitionName = args[3];
    const value = args[4];

    if (!blockId || !transitionTaskId || !transitionName) {
      console.error('[block-transition] Error: block id, task id, and transition are required');
      console.error('[block-transition] Usage: block-transition <blockId> <taskId> <transition> [value]');
      process.exit(1);
    }

    const validTransitions = [
      'in_progress',
      'coder_done',
      'checks_failed',
      'committed',
      'pushed',
      'waiting_review',
      'accepted',
      'rejected',
      'fix_required',
      'blocked',
    ];
    if (!validTransitions.includes(transitionName)) {
      console.error(`[block-transition] Error: unknown transition "${transitionName}"`);
      console.error(`[block-transition] Valid transitions: ${validTransitions.join(', ')}`);
      process.exit(1);
    }

    const updated = updateBlockState(blockId, (state) => {
      switch (transitionName) {
        case 'in_progress':
          return markTaskInProgress(state, transitionTaskId);
        case 'coder_done':
          return markTaskCoderDone(state, transitionTaskId);
        case 'checks_failed':
          return markTaskChecksFailed(state, transitionTaskId, value ? [value] : []);
        case 'committed':
          return markTaskCommitted(state, transitionTaskId, value || '');
        case 'pushed':
          return markTaskPushed(state, transitionTaskId, value || '', 'origin');
        case 'waiting_review':
          return markTaskWaitingReview(state, transitionTaskId);
        case 'accepted':
          return markTaskAccepted(state, transitionTaskId, value || '');
        case 'rejected':
          return markTaskRejected(state, transitionTaskId, value ? [value] : [], '');
        case 'fix_required':
          return markTaskFixRequired(state, transitionTaskId, value ? [value] : [], '');
        case 'blocked':
          return markTaskBlocked(state, transitionTaskId, value ? [value] : [], '');
        default:
          throw new Error(`Unhandled transition: ${transitionName}`);
      }
    });

    console.log(`[block-transition] Transition applied: ${transitionName}`);
    console.log(`[block-transition] Block: ${updated.block_id}`);
    console.log(`[block-transition] Task: ${transitionTaskId}`);
    console.log(`[block-transition] Block status: ${updated.status}`);
    console.log(`[block-transition] Current task: ${updated.current_task_id ?? 'none'}`);
    console.log('[block-transition] No provider call was made');
    console.log('[block-transition] No git command was executed');
    console.log('[block-transition] No merge was performed');
    console.log('[block-transition] No checkout was performed');
    console.log('[block-transition] No main touch was performed');
    process.exit(0);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[block-transition] Error: ${message}`);
    console.error('[block-transition] No merge was performed');
    console.error('[block-transition] No checkout was performed');
    console.error('[block-transition] No main touch was performed');
    process.exit(1);
  }
}

if (command === 'block-run-one') {
  try {
    const blockJsonPath = taskId;
    if (!blockJsonPath) {
      console.error('[block-run-one] Error: block JSON path is required');
      process.exit(1);
    }

    // Load definition to resolve blockId
    const definition = loadBlockDefinition(blockJsonPath);
    const blockId = definition.block_id;

    // Ensure state exists
    let blockState = loadBlockState(blockId);
    if (!blockState) {
      blockState = initBlockState(definition);
      saveBlockState(blockState);
    }

    const mode = (process.env.BLOCK_RUN_ONE_MODE as import('./block/block-runner-types.js').OneTaskLoopMode) || 'fake';
    const allowBlockRunOne = process.env.ALLOW_BLOCK_RUN_ONE === 'true';
    const allowRealProvider = process.env.ALLOW_REAL_PROVIDER === 'true';
    const allowRealRepoApply = process.env.ALLOW_REAL_REPO_APPLY === 'true';
    const allowRealRepoCommit = process.env.ALLOW_REAL_REPO_COMMIT === 'true';
    const allowRealRepoPush = process.env.ALLOW_REAL_REPO_PUSH === 'true';
    const allowKimiReviewer = process.env.ALLOW_KIMI_REVIEWER === 'true';
    const reviewerProvider = (process.env.REVIEWER_PROVIDER as 'fake' | 'kimi') || 'fake';
    const coderProvider = (process.env.CODER_PROVIDER as 'fake' | 'kimi') || 'fake';
    const result = await runOneTaskLoop({
      blockId,
      mode,
      allowBlockRunOne,
      allowRealProvider,
      allowRealRepoApply,
      allowRealRepoCommit,
      allowRealRepoPush,
      allowKimiReviewer,
      reviewerProvider,
      coderProvider,
      blockDefinitionPath: blockJsonPath,
    });

    console.log(`[block-run-one] Block: ${result.block_id}`);
    console.log(`[block-run-one] Task: ${result.task_id}`);
    console.log(`[block-run-one] Status: ${result.status_before} → ${result.status_after}`);
    console.log(`[block-run-one] Coder called: ${result.coder_called}`);
    console.log(`[block-run-one] Reviewer called: ${result.reviewer_called}`);
    console.log(`[block-run-one] Files applied: ${result.files_applied.join(', ')}`);
    console.log(`[block-run-one] Checks passed: ${result.checks_passed}`);
    console.log(`[block-run-one] Commit SHA: ${result.commit_sha ?? 'none'}`);
    console.log(`[block-run-one] Pushed: ${result.pushed}`);
    console.log(`[block-run-one] Reviewer decision: ${result.reviewer_decision ?? 'none'}`);
    console.log(`[block-run-one] Next action: ${result.next_action}`);
    console.log('[block-run-one] No merge was performed');
    console.log('[block-run-one] No checkout was performed');
    console.log('[block-run-one] No main touch was performed');
    process.exit(0);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[block-run-one] Error: ${message}`);
    console.error('[block-run-one] No merge was performed');
    console.error('[block-run-one] No checkout was performed');
    console.error('[block-run-one] No main touch was performed');
    process.exit(1);
  }
}

if (command === 'block-run') {
  try {
    const blockJsonPath = taskId;
    if (!blockJsonPath) {
      console.error('[block-run] Error: block JSON path is required');
      process.exit(1);
    }

    const mode = (process.env.BLOCK_RUN_MODE as import('./block/block-multi-runner-types.js').MultiTaskLoopMode) || 'fake';
    const validModes: import('./block/block-multi-runner-types.js').MultiTaskLoopMode[] = [
      'fake',
      'real_kimi_coder_fake_reviewer',
      'real_kimi_coder_kimi_reviewer',
    ];
    if (!validModes.includes(mode)) {
      console.error(`[block-run] Error: BLOCK_RUN_MODE must be one of: ${validModes.join(', ')}`);
      process.exit(1);
    }

    const isRealMode = mode !== 'fake';
    const defaultMaxTasks = isRealMode ? 3 : 10;
    const rawMaxTasks = process.env.BLOCK_RUN_MAX_TASKS;
    const maxTasksPerRun = rawMaxTasks ? parseInt(rawMaxTasks, 10) : defaultMaxTasks;
    const maxLimit = isRealMode ? 3 : 100;

    if (!Number.isFinite(maxTasksPerRun) || maxTasksPerRun < 1 || maxTasksPerRun > maxLimit) {
      console.error(`[block-run] Error: BLOCK_RUN_MAX_TASKS must be between 1 and ${maxLimit} for ${mode} mode`);
      process.exit(1);
    }

    const rawMaxTotalAttempts = process.env.BLOCK_RUN_MAX_TOTAL_ATTEMPTS;
    const maxTotalAttemptsPerRun = rawMaxTotalAttempts ? parseInt(rawMaxTotalAttempts, 10) : 20;
    if (!Number.isFinite(maxTotalAttemptsPerRun) || maxTotalAttemptsPerRun < 1 || maxTotalAttemptsPerRun > 100) {
      console.error('[block-run] Error: BLOCK_RUN_MAX_TOTAL_ATTEMPTS must be between 1 and 100');
      process.exit(1);
    }

    const stopOnRejected = process.env.BLOCK_RUN_STOP_ON_REJECTED !== 'false';
    const stopOnBlocked = process.env.BLOCK_RUN_STOP_ON_BLOCKED !== 'false';

    const allowBlockRunOne = process.env.ALLOW_BLOCK_RUN_ONE === 'true';
    const allowRealProvider = process.env.ALLOW_REAL_PROVIDER === 'true';
    const allowRealRepoApply = process.env.ALLOW_REAL_REPO_APPLY === 'true';
    const allowRealRepoCommit = process.env.ALLOW_REAL_REPO_COMMIT === 'true';
    const allowRealRepoPush = process.env.ALLOW_REAL_REPO_PUSH === 'true';
    const allowKimiReviewer = process.env.ALLOW_KIMI_REVIEWER === 'true';
    const reviewerProvider = (process.env.REVIEWER_PROVIDER as 'fake' | 'kimi') || 'fake';
    const coderProvider = (process.env.CODER_PROVIDER as 'fake' | 'kimi') || 'fake';

    const result = await runMultiTaskLoop({
      blockDefinitionPath: blockJsonPath,
      mode,
      maxTasksPerRun,
      maxTotalAttemptsPerRun,
      stopOnRejected,
      stopOnBlocked,
      allowBlockRunOne,
      allowRealProvider,
      allowRealRepoApply,
      allowRealRepoCommit,
      allowRealRepoPush,
      allowKimiReviewer,
      reviewerProvider,
      coderProvider,
    });

    console.log(`[block-run] Block: ${result.block_id}`);
    console.log(`[block-run] Mode: ${result.mode}`);
    console.log(`[block-run] Tasks attempted: ${result.tasks_attempted}`);
    console.log(`[block-run] Accepted: ${result.tasks_accepted}`);
    console.log(`[block-run] Fix required: ${result.tasks_fix_required}`);
    console.log(`[block-run] Blocked: ${result.tasks_blocked}`);
    console.log(`[block-run] Final block status: ${result.final_block_status}`);
    console.log(`[block-run] Current task: ${result.current_task_id ?? 'none'}`);

    for (const r of result.results) {
      console.log(`[block-run] Task ${r.task_id}: ${r.status_before} → ${r.status_after}`);
      console.log(`[block-run]   Coder called: ${r.coder_called}`);
      console.log(`[block-run]   Reviewer called: ${r.reviewer_called}`);
      console.log(`[block-run]   Commit SHA: ${r.commit_sha ?? 'none'}`);
      console.log(`[block-run]   Pushed: ${r.pushed}`);
      console.log(`[block-run]   Reviewer decision: ${r.reviewer_decision ?? 'none'}`);
      console.log(`[block-run]   Next action: ${r.next_action}`);
    }

    if (result.safety_findings.length > 0) {
      console.log(`[block-run] Safety findings: ${result.safety_findings.join('; ')}`);
    }

    console.log('[block-run] No merge was performed');
    console.log('[block-run] No checkout was performed');
    console.log('[block-run] No main touch was performed');
    console.log('[block-run] No PR was created');
    if (!allowRealRepoPush) {
      console.log('[block-run] No auto-push was performed');
    }
    process.exit(0);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[block-run] Error: ${message}`);
    console.error('[block-run] No merge was performed');
    console.error('[block-run] No checkout was performed');
    console.error('[block-run] No main touch was performed');
    console.error('[block-run] No PR was created');
    process.exit(1);
  }
}

if (command === 'block-approval-report') {
  try {
    const blockJsonPath = taskId;
    if (!blockJsonPath) {
      console.error('[block-approval-report] Error: block JSON path is required');
      process.exit(1);
    }

    const outputPath = process.env.BLOCK_APPROVAL_REPORT_OUTPUT?.trim();
    const includeDiff = process.env.BLOCK_APPROVAL_INCLUDE_DIFF_SUMMARY === 'true';

    const { generateBlockApprovalReport } = await import('./block/block-approval-report.js');
    const result = generateBlockApprovalReport({
      blockDefinitionPath: blockJsonPath,
      outputPath: outputPath || undefined,
      includeGitDiffSummary: includeDiff,
    });

    console.log(`[block-approval-report] Block: ${result.block_id}`);
    console.log(`[block-approval-report] Report: ${result.output_path}`);
    console.log(`[block-approval-report] Block status: ${result.block_status}`);
    console.log(`[block-approval-report] Tasks accepted: ${result.tasks_accepted}/${result.tasks_total}`);
    console.log(`[block-approval-report] PR-ready: ${result.pr_ready ? 'yes' : 'no'}`);
    console.log(`[block-approval-report] Blocking issues: ${result.blocking_issues.length}`);
    if (result.safety_findings.length > 0) {
      console.log(`[block-approval-report] Safety findings: ${result.safety_findings.join('; ')}`);
    }
    console.log('[block-approval-report] No provider call was made');
    console.log('[block-approval-report] No GitHub API call was made');
    console.log('[block-approval-report] No PR was created');
    console.log('[block-approval-report] No push was performed');
    console.log('[block-approval-report] No merge was performed');
    console.log('[block-approval-report] No checkout was performed');
    console.log('[block-approval-report] No main touch was performed');
    process.exit(0);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[block-approval-report] Error: ${message}`);
    console.error('[block-approval-report] No provider call was made');
    console.error('[block-approval-report] No GitHub API call was made');
    console.error('[block-approval-report] No PR was created');
    console.error('[block-approval-report] No push was performed');
    console.error('[block-approval-report] No merge was performed');
    console.error('[block-approval-report] No checkout was performed');
    console.error('[block-approval-report] No main touch was performed');
    process.exit(1);
  }
}

if (command === 'block-pr-draft') {
  try {
    const blockJsonPath = taskId;
    if (!blockJsonPath) {
      console.error('[block-pr-draft] Error: block JSON path is required');
      process.exit(1);
    }

    const outputDir = process.env.BLOCK_PR_DRAFT_OUTPUT_DIR?.trim();
    const includeDiff = process.env.BLOCK_PR_DRAFT_INCLUDE_DIFF_STAT === 'true';

    const { generateBlockPrDraft } = await import('./block/block-pr-draft.js');
    const result = generateBlockPrDraft({
      blockDefinitionPath: blockJsonPath,
      outputDir: outputDir || undefined,
      includeDiffStat: includeDiff,
    });

    console.log(`[block-pr-draft] Block: ${result.block_id}`);
    console.log(`[block-pr-draft] Output dir: ${result.output_dir}`);
    console.log(`[block-pr-draft] Title: ${result.title_path}`);
    console.log(`[block-pr-draft] Body: ${result.body_path}`);
    console.log(`[block-pr-draft] Checklist: ${result.checklist_path}`);
    console.log(`[block-pr-draft] PR-ready: ${result.pr_ready ? 'yes' : 'no'}`);
    console.log(`[block-pr-draft] Tasks accepted: ${result.tasks_accepted}/${result.tasks_total}`);
    console.log(`[block-pr-draft] Blocking issues: ${result.blocking_issues.length}`);
    if (result.safety_findings.length > 0) {
      console.log(`[block-pr-draft] Safety findings: ${result.safety_findings.join('; ')}`);
    }
    console.log('[block-pr-draft] No provider call was made');
    console.log('[block-pr-draft] No GitHub API call was made');
    console.log('[block-pr-draft] No PR was created');
    console.log('[block-pr-draft] No PR was updated');
    console.log('[block-pr-draft] No push was performed');
    console.log('[block-pr-draft] No merge was performed');
    console.log('[block-pr-draft] No checkout was performed');
    console.log('[block-pr-draft] No main touch was performed');
    process.exit(0);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[block-pr-draft] Error: ${message}`);
    console.error('[block-pr-draft] No provider call was made');
    console.error('[block-pr-draft] No GitHub API call was made');
    console.error('[block-pr-draft] No PR was created');
    console.error('[block-pr-draft] No PR was updated');
    console.error('[block-pr-draft] No push was performed');
    console.error('[block-pr-draft] No merge was performed');
    console.error('[block-pr-draft] No checkout was performed');
    console.error('[block-pr-draft] No main touch was performed');
    process.exit(1);
  }
}

if (command === 'block-pr-create') {
  try {
    const blockJsonPath = taskId;
    if (!blockJsonPath) {
      console.error('[block-pr-create] Error: block JSON path is required');
      process.exit(1);
    }

    const draftDir = process.env.BLOCK_PR_DRAFT_OUTPUT_DIR?.trim();
    const isDryRun = process.env.BLOCK_PR_CREATE_DRY_RUN === 'true';

    const { createBlockPullRequest } = await import('./block/block-pr-create.js');
    const result = await createBlockPullRequest({
      blockDefinitionPath: blockJsonPath,
      draftDir: draftDir || undefined,
      dryRun: isDryRun,
    });

    console.log(`[block-pr-create] Block: ${result.block_id}`);
    console.log(`[block-pr-create] Dry run: ${result.dry_run ? 'yes' : 'no'}`);
    if (result.dry_run) {
      console.log(`[block-pr-create] Would create draft PR: yes`);
      console.log(`[block-pr-create] Base: ${result.base_branch}`);
      console.log(`[block-pr-create] Head: ${result.work_branch}`);
      console.log(`[block-pr-create] Title: ${result.title}`);
      console.log(`[block-pr-create] Body: ${result.body_path}`);
    } else {
      console.log(`[block-pr-create] PR created: ${result.pr_created ? 'yes' : 'no'}`);
      if (result.pr_number) {
        console.log(`[block-pr-create] PR number: ${result.pr_number}`);
        console.log(`[block-pr-create] PR URL: ${result.pr_url}`);
      }
      if (result.output_path) {
        console.log(`[block-pr-create] Output: ${result.output_path}`);
      }
    }
    console.log('[block-pr-create] No provider call was made');
    console.log('[block-pr-create] No push was performed');
    console.log('[block-pr-create] No merge was performed');
    console.log('[block-pr-create] No checkout was performed');
    console.log('[block-pr-create] No main touch was performed');
    process.exit(0);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[block-pr-create] Error: ${message}`);
    console.error('[block-pr-create] No PR was created');
    console.error('[block-pr-create] No push was performed');
    console.error('[block-pr-create] No merge was performed');
    console.error('[block-pr-create] No checkout was performed');
    console.error('[block-pr-create] No main touch was performed');
    console.error('[block-pr-create] No provider call was made');
    process.exit(1);
  }
}

if (command === 'block-pr-status') {
  try {
    const blockJsonPath = taskId;
    if (!blockJsonPath) {
      console.error('[block-pr-status] Error: block JSON path is required');
      process.exit(1);
    }

    const outputPath = process.env.BLOCK_PR_STATUS_OUTPUT?.trim();
    const prNumberEnv = process.env.BLOCK_PR_NUMBER?.trim();
    const prNumber = prNumberEnv ? parseInt(prNumberEnv, 10) : undefined;

    const { getBlockPrStatus } = await import('./block/block-pr-status.js');
    const result = await getBlockPrStatus({
      blockDefinitionPath: blockJsonPath,
      prNumber,
      outputPath: outputPath || undefined,
    });

    console.log(`[block-pr-status] Block: ${result.block_id}`);
    console.log(`[block-pr-status] PR number: ${result.pr_number}`);
    console.log(`[block-pr-status] PR URL: ${result.pr_url}`);
    console.log(`[block-pr-status] State: ${result.state}`);
    console.log(`[block-pr-status] Draft: ${result.draft ? 'yes' : 'no'}`);
    console.log(`[block-pr-status] Merged: ${result.merged ? 'yes' : 'no'}`);
    console.log(`[block-pr-status] Base: ${result.base_branch}`);
    console.log(`[block-pr-status] Head: ${result.head_branch}`);
    console.log(`[block-pr-status] Checks: ${result.checks_status}`);
    console.log(`[block-pr-status] Safe for human review: ${result.pr_safe_for_human_review ? 'yes' : 'no'}`);
    console.log(`[block-pr-status] Source mode: ${result.source_mode}`);
    console.log(`[block-pr-status] GitHub API verified: ${result.github_api_verified ? 'yes' : 'no'}`);
    console.log(`[block-pr-status] Mock used: ${result.mock_used ? 'yes' : 'no'}`);
    if (result.mock_used) {
      console.log('[block-pr-status] Warning: mock response used; real GitHub API status was not verified by this run');
    }
    console.log(`[block-pr-status] Report: ${result.output_path}`);
    if (result.safety_findings.length > 0) {
      console.log(`[block-pr-status] Safety findings: ${result.safety_findings.join('; ')}`);
    }
    if (result.blocking_issues.length > 0) {
      console.log(`[block-pr-status] Blocking issues: ${result.blocking_issues.join('; ')}`);
    }
    console.log('[block-pr-status] No PR was created');
    console.log('[block-pr-status] No PR was updated');
    console.log('[block-pr-status] No PR was closed');
    console.log('[block-pr-status] No merge was performed');
    console.log('[block-pr-status] No push was performed');
    console.log('[block-pr-status] No checkout was performed');
    console.log('[block-pr-status] No main touch was performed');
    console.log('[block-pr-status] No provider call was made');
    process.exit(0);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[block-pr-status] Error: ${message}`);
    console.error('[block-pr-status] No PR was created');
    console.error('[block-pr-status] No PR was updated');
    console.error('[block-pr-status] No PR was closed');
    console.error('[block-pr-status] No merge was performed');
    console.error('[block-pr-status] No push was performed');
    console.error('[block-pr-status] No checkout was performed');
    console.error('[block-pr-status] No main touch was performed');
    console.error('[block-pr-status] No provider call was made');
    process.exit(1);
  }
}

if (command === 'block-pr-readiness') {
  try {
    const blockJsonPath = taskId;
    if (!blockJsonPath) {
      console.error('[block-pr-readiness] Error: block JSON path is required');
      process.exit(1);
    }

    const outputPath = process.env.BLOCK_PR_READINESS_OUTPUT?.trim();
    const prNumberEnv = process.env.BLOCK_PR_NUMBER?.trim();
    const prNumber = prNumberEnv ? parseInt(prNumberEnv, 10) : undefined;

    const { checkBlockPrReadiness } = await import('./block/block-pr-readiness.js');
    const result = await checkBlockPrReadiness({
      blockDefinitionPath: blockJsonPath,
      prNumber,
      outputPath: outputPath || undefined,
    });

    console.log(`[block-pr-readiness] Block: ${result.block_id}`);
    console.log(`[block-pr-readiness] PR number: ${result.pr_number}`);
    console.log(`[block-pr-readiness] PR URL: ${result.pr_url}`);
    console.log(`[block-pr-readiness] State: ${result.state}`);
    console.log(`[block-pr-readiness] Draft: ${result.draft ? 'yes' : 'no'}`);
    console.log(`[block-pr-readiness] Merged: ${result.merged ? 'yes' : 'no'}`);
    console.log(`[block-pr-readiness] Base: ${result.base_branch}`);
    console.log(`[block-pr-readiness] Head: ${result.head_branch}`);
    console.log(`[block-pr-readiness] Head SHA: ${result.head_sha}`);
    console.log(`[block-pr-readiness] Checks: ${result.checks_status}`);
    console.log(`[block-pr-readiness] Readiness: ${result.readiness}`);
    console.log(`[block-pr-readiness] Dry run: ${result.dry_run ? 'yes' : 'no'}`);
    console.log(`[block-pr-readiness] Would mark ready: ${result.would_mark_ready ? 'yes' : 'no'}`);
    console.log(`[block-pr-readiness] Marked ready: ${result.marked_ready ? 'yes' : 'no'}`);
    console.log(`[block-pr-readiness] Report: ${result.output_path}`);
    if (result.safety_findings.length > 0) {
      console.log(`[block-pr-readiness] Safety findings: ${result.safety_findings.join('; ')}`);
    }
    if (result.blocking_issues.length > 0) {
      console.log(`[block-pr-readiness] Blocking issues: ${result.blocking_issues.join('; ')}`);
    }
    console.log('[block-pr-readiness] No merge was performed');
    console.log('[block-pr-readiness] No auto-merge was performed');
    console.log('[block-pr-readiness] No push was performed');
    console.log('[block-pr-readiness] No checkout was performed');
    console.log('[block-pr-readiness] No main touch was performed');
    console.log('[block-pr-readiness] No provider call was made');
    process.exit(0);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[block-pr-readiness] Error: ${message}`);
    console.error('[block-pr-readiness] No merge was performed');
    console.error('[block-pr-readiness] No auto-merge was performed');
    console.error('[block-pr-readiness] No push was performed');
    console.error('[block-pr-readiness] No checkout was performed');
    console.error('[block-pr-readiness] No main touch was performed');
    console.error('[block-pr-readiness] No provider call was made');
    process.exit(1);
  }
}

if (command === 'block-pr-submit') {
  try {
    const blockJsonPath = taskId;
    if (!blockJsonPath) {
      console.error('[block-pr-submit] Error: block JSON path is required');
      process.exit(1);
    }

    const { submitBlockPr } = await import('./block/block-pr-submit.js');
    const result = await submitBlockPr({
      blockDefinitionPath: blockJsonPath,
    });

    console.log(`[block-pr-submit] Block: ${result.block_id}`);
    console.log(`[block-pr-submit] Dry run: ${result.dry_run ? 'yes' : 'no'}`);
    console.log(`[block-pr-submit] PR-ready: ${result.dry_run ? 'validated' : result.pr_created ? 'yes' : 'no'}`);
    if (!result.dry_run) {
      console.log(`[block-pr-submit] PR created: ${result.pr_created ? 'yes' : 'no'}`);
      if (result.pr_number) {
        console.log(`[block-pr-submit] PR number: ${result.pr_number}`);
        console.log(`[block-pr-submit] PR URL: ${result.pr_url}`);
      }
    }
    console.log(`[block-pr-submit] Approval report: ${result.approval_report_path}`);
    console.log(`[block-pr-submit] Draft dir: ${result.draft_dir}`);
    console.log(`[block-pr-submit] Report: ${result.output_path}`);
    if (result.pr_status_checked) {
      console.log(`[block-pr-submit] PR status checked: yes (${result.pr_status_source_mode ?? 'unknown'})`);
    }
    if (result.safety_findings.length > 0) {
      console.log(`[block-pr-submit] Safety findings: ${result.safety_findings.join('; ')}`);
    }
    console.log('[block-pr-submit] No merge was performed');
    console.log('[block-pr-submit] No auto-merge was performed');
    console.log('[block-pr-submit] No push was performed');
    console.log('[block-pr-submit] No checkout was performed');
    console.log('[block-pr-submit] No main touch was performed');
    console.log('[block-pr-submit] No provider call was made');
    process.exit(0);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[block-pr-submit] Error: ${message}`);
    console.error('[block-pr-submit] No merge was performed');
    console.error('[block-pr-submit] No auto-merge was performed');
    console.error('[block-pr-submit] No push was performed');
    console.error('[block-pr-submit] No checkout was performed');
    console.error('[block-pr-submit] No main touch was performed');
    console.error('[block-pr-submit] No provider call was made');
    process.exit(1);
  }
}

if (command === 'block-pr-cleanup') {
  try {
    const blockJsonPath = taskId;
    if (!blockJsonPath) {
      console.error('[block-pr-cleanup] Error: block JSON path is required');
      process.exit(1);
    }

    const outputPath = process.env.BLOCK_PR_CLEANUP_OUTPUT?.trim();
    const prNumberEnv = process.env.BLOCK_PR_NUMBER?.trim();
    const prNumber = prNumberEnv ? parseInt(prNumberEnv, 10) : undefined;
    const closePr = process.env.BLOCK_PR_CLEANUP_CLOSE_PR === 'true';
    const deleteBranch = process.env.BLOCK_PR_CLEANUP_DELETE_BRANCH === 'true';
    const dryRunEnv = process.env.BLOCK_PR_CLEANUP_DRY_RUN?.trim();
    const dryRun = dryRunEnv === 'false' ? false : dryRunEnv === 'true' ? true : undefined;

    const { cleanupBlockProofPr } = await import('./block/block-pr-cleanup.js');
    const result = await cleanupBlockProofPr({
      blockDefinitionPath: blockJsonPath,
      prNumber,
      closePr,
      deleteBranch,
      dryRun,
      outputPath: outputPath || undefined,
    });

    console.log(`[block-pr-cleanup] Block: ${result.block_id}`);
    console.log(`[block-pr-cleanup] PR number: ${result.pr_number}`);
    console.log(`[block-pr-cleanup] PR URL: ${result.pr_url}`);
    console.log(`[block-pr-cleanup] Dry run: ${result.dry_run ? 'yes' : 'no'}`);
    console.log(`[block-pr-cleanup] Close PR requested: ${result.close_pr_requested ? 'yes' : 'no'}`);
    console.log(`[block-pr-cleanup] Delete branch requested: ${result.delete_branch_requested ? 'yes' : 'no'}`);
    console.log(`[block-pr-cleanup] PR closed: ${result.pr_closed ? 'yes' : 'no'}`);
    console.log(`[block-pr-cleanup] Branch deleted: ${result.branch_deleted ? 'yes' : 'no'}`);
    console.log(`[block-pr-cleanup] Cleanup safe: ${result.cleanup_safe ? 'yes' : 'no'}`);
    console.log(`[block-pr-cleanup] Report: ${result.output_path}`);
    console.log(`[block-pr-cleanup] Blocking issues: ${result.blocking_issues.length}`);
    console.log(`[block-pr-cleanup] Safety findings: ${result.safety_findings.length}`);
    console.log('[block-pr-cleanup] No merge was performed');
    console.log('[block-pr-cleanup] No auto-merge was performed');
    console.log('[block-pr-cleanup] No push was performed');
    console.log('[block-pr-cleanup] No checkout was performed');
    console.log('[block-pr-cleanup] No main touch was performed');
    console.log('[block-pr-cleanup] No provider call was made');
    console.log('[block-pr-cleanup] No token was persisted');
    process.exit(0);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[block-pr-cleanup] Error: ${message}`);
    console.error('[block-pr-cleanup] No merge was performed');
    console.error('[block-pr-cleanup] No auto-merge was performed');
    console.error('[block-pr-cleanup] No push was performed');
    console.error('[block-pr-cleanup] No checkout was performed');
    console.error('[block-pr-cleanup] No main touch was performed');
    console.error('[block-pr-cleanup] No provider call was made');
    console.error('[block-pr-cleanup] No token was persisted');
    process.exit(1);
  }
}

if (command === 'block-sandbox') {
  try {
    const blockJsonPath = taskId;
    if (!blockJsonPath) {
      console.error('[block-sandbox] Error: block JSON path is required');
      process.exit(1);
    }

    const outputPath = process.env.BLOCK_SANDBOX_OUTPUT?.trim();
    const sandboxPath = process.env.BLOCK_SANDBOX_PATH?.trim();
    const baseRef = process.env.BLOCK_SANDBOX_BASE?.trim();
    const keep = process.env.BLOCK_SANDBOX_KEEP === 'true';

    const { runBlockSandbox } = await import('./block/block-sandbox.js');
    const result = runBlockSandbox({
      blockDefinitionPath: blockJsonPath,
      outputPath: outputPath || undefined,
      sandboxPath: sandboxPath || undefined,
      baseRef: baseRef || undefined,
      keep,
    });

    console.log(`[block-sandbox] Block: ${result.block_id}`);
    console.log(`[block-sandbox] Base branch: ${result.base_branch}`);
    console.log(`[block-sandbox] Base commit: ${result.base_commit}`);
    console.log(`[block-sandbox] Sandbox path: ${result.sandbox_path}`);
    console.log(`[block-sandbox] Type check: ${result.typecheck_result}`);
    console.log(`[block-sandbox] Build: ${result.build_result}`);
    console.log(`[block-sandbox] Tests: ${result.test_result}`);
    console.log(`[block-sandbox] Main status before: ${result.main_status_before}`);
    console.log(`[block-sandbox] Main status after: ${result.main_status_after}`);
    console.log(`[block-sandbox] Main HEAD before: ${result.main_head_before}`);
    console.log(`[block-sandbox] Main HEAD after: ${result.main_head_after}`);
    console.log(`[block-sandbox] Sandbox status: ${result.sandbox_status}`);
    console.log(`[block-sandbox] Path validation: ${result.path_validation}`);
    console.log(`[block-sandbox] Worktree registered: ${result.worktree_registered ? 'yes' : 'no'}`);
    console.log(`[block-sandbox] Cleanup: ${result.cleanup_result}`);
    console.log(`[block-sandbox] Cleanup verified: ${result.cleanup_verified ? 'yes' : 'no'}`);
    console.log(`[block-sandbox] Redaction applied: ${result.redaction_applied ? 'yes' : 'no'}`);
    console.log(`[block-sandbox] Report: ${result.output_path}`);
    if (result.safety_findings.length > 0) {
      console.log(`[block-sandbox] Safety findings: ${result.safety_findings.join('; ')}`);
    }
    if (result.blocking_issues.length > 0) {
      console.log(`[block-sandbox] Blocking issues: ${result.blocking_issues.join('; ')}`);
    }
    console.log('[block-sandbox] No merge was performed');
    console.log('[block-sandbox] No auto-merge was performed');
    console.log('[block-sandbox] No push was performed');
    console.log('[block-sandbox] No checkout was performed');
    console.log('[block-sandbox] No main touch was performed');
    console.log('[block-sandbox] No provider call was made');
    process.exit(0);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[block-sandbox] Error: ${message}`);
    console.error('[block-sandbox] No merge was performed');
    console.error('[block-sandbox] No auto-merge was performed');
    console.error('[block-sandbox] No push was performed');
    console.error('[block-sandbox] No checkout was performed');
    console.error('[block-sandbox] No main touch was performed');
    console.error('[block-sandbox] No provider call was made');
    process.exit(1);
  }
}

if (process.exitCode === undefined) {
  console.error(`Unknown command: ${command}`);
  process.exitCode = 1;
}

}

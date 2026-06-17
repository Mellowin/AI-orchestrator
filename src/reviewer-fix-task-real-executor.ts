import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Task, KimiOutput } from './types.js';
import { buildContext } from './context-builder.js';
import { buildKimiPrompt } from './prompt-builder.js';
import {
  createRealProviderCall,
  buildProviderCallInput,
  normalizeProviderCallResult,
  normalizeProviderCallError,
  type FetchFn,
} from './provider-call.js';
import { parseKimiOutputJson } from './kimi-output-validator.js';
import {
  validateFileList,
  validateProposedFileLineDeltas,
} from './guardrails.js';
import { applyFileUpdates, rollbackFileUpdates } from './patch-engine.js';
import { runChecks } from './runner.js';
import { runRealRepoSandboxPreflight } from './real-repo-sandbox-preflight.js';
import {
  ensureClean,
  getCurrentBranch,
  getChangedFiles,
} from './git-manager.js';
import { validateRealRepoApplySafety } from './real-repo-apply-safety.js';
import { buildRealRepoApplyPlan } from './real-repo-apply-plan.js';
import { redactSecrets } from './sandbox-preflight-repair.js';
import type {
  ReviewerFixTaskExecutor,
  ReviewerFixTaskExecutorInput,
  ReviewerFixTaskExecutorResult,
} from './reviewer-fix-task-runner.js';

export interface CreateReviewerFixTaskRealExecutorOptions {
  parentTask: Task;
}

function countLines(text: string): number {
  if (text.length === 0) return 0;
  const lines = text.split('\n');
  return text.endsWith('\n') ? lines.length - 1 : lines.length;
}

function buildFixTaskPrompt(
  input: ReviewerFixTaskExecutorInput,
  context: {
    parentGoal: string;
    allowedFiles: string[];
    deniedFiles: string[];
    previousChangedFiles: string[];
    checks: Array<{ command: string; args: string[] }>;
  }
): string {
  const blocking = input.blockingIssues.length > 0
    ? input.blockingIssues.map((i) => `- ${i}`).join('\n')
    : '- No blocking issues';

  const allowed = context.allowedFiles.length > 0
    ? context.allowedFiles.map((f) => `- ${f}`).join('\n')
    : '- No allowed files specified';

  const denied = context.deniedFiles.length > 0
    ? context.deniedFiles.map((f) => `- ${f}`).join('\n')
    : '- No denied files specified';

  const previous = context.previousChangedFiles.length > 0
    ? context.previousChangedFiles.map((f) => `- ${f}`).join('\n')
    : '- No previous changed files';

  const checks = context.checks.length > 0
    ? context.checks.map((c) => `- ${c.command} ${c.args.join(' ')}`).join('\n')
    : '- No checks';

  return (
    `# Reviewer Fix Task\n\n` +
    `Task ID: ${input.taskId}\n` +
    `Parent Task ID: ${input.parentTaskId}\n` +
    `Attempt: ${input.attempt}\n` +
    `Title: ${input.title}\n` +
    `Fix Task Goal: ${input.goal}\n` +
    `Original Parent Task Goal: ${context.parentGoal}\n\n` +
    `# Blocking Issues to Address\n\n${blocking}\n\n` +
    `# Allowed Files\n\n${allowed}\n\n` +
    `# Denied Files\n\n${denied}\n\n` +
    `# Previous Changed Files\n\n${previous}\n\n` +
    `# Check Commands\n\n${checks}\n\n` +
    `# Instructions\n\n` +
    `Apply the minimal safe fix to address the blocking issues. ` +
    `Return ONLY valid JSON using the file_update schema. ` +
    `Return full file content, not diffs. ` +
    `Do not include markdown outside JSON. ` +
    `Do not modify files outside allowed scope.`
  );
}

function buildFetchFnForFixTask(): FetchFn | undefined {
  const fakeResponsesRaw = process.env.REAL_REPO_REVIEWER_FIX_TASK_KIMI_FAKE_RESPONSES;
  const fakeResponse = process.env.REAL_REPO_REVIEWER_FIX_TASK_KIMI_FAKE_RESPONSE;

  if (fakeResponsesRaw !== undefined) {
    let fakeResponses: string[];
    try {
      const parsed = JSON.parse(fakeResponsesRaw);
      fakeResponses = Array.isArray(parsed) ? parsed : [];
    } catch {
      fakeResponses = [];
    }
    let index = 0;
    return async () => {
      const content = fakeResponses[index] ?? '';
      index++;
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
  }

  if (fakeResponse !== undefined) {
    return async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content: fakeResponse } }],
      }),
    });
  }

  if (typeof globalThis.fetch !== 'function') {
    return undefined;
  }
  return globalThis.fetch as unknown as FetchFn;
}

function blockResult(
  reason: string,
  blockingIssues: string[] = []
): ReviewerFixTaskExecutorResult {
  return {
    status: 'blocked',
    reason: redactSecrets(reason),
    blockingIssues: blockingIssues.map((i) => redactSecrets(i)),
  };
}

function getCommitChangedFiles(repoPath: string, commitSha: string): string[] {
  const result = spawnSync(
    'git',
    ['diff-tree', '--no-commit-id', '--name-only', '-r', '--root', commitSha],
    {
      cwd: repoPath,
      encoding: 'utf-8',
      shell: false,
    }
  );
  if (result.status !== 0) {
    return [];
  }
  return result.stdout
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

export function createReviewerFixTaskRealExecutor(
  options: CreateReviewerFixTaskRealExecutorOptions
): ReviewerFixTaskExecutor {
  const { parentTask } = options;

  return async (
    input: ReviewerFixTaskExecutorInput
  ): Promise<ReviewerFixTaskExecutorResult> => {
    if (process.env.ALLOW_REAL_PROVIDER !== 'true') {
      return blockResult('ALLOW_REAL_PROVIDER=true is required to execute reviewer fix task.');
    }
    if (process.env.ALLOW_REAL_REPO_APPLY !== 'true') {
      return blockResult('ALLOW_REAL_REPO_APPLY=true is required to execute reviewer fix task.');
    }
    if (process.env.ALLOW_REAL_REPO_COMMIT !== 'true') {
      return blockResult('ALLOW_REAL_REPO_COMMIT=true is required to execute reviewer fix task.');
    }

    const apiKey = process.env.KIMI_API_KEY?.trim();
    if (!apiKey) {
      return blockResult('KIMI_API_KEY env var is required.');
    }

    const baseUrl = process.env.KIMI_BASE_URL?.trim();
    if (!baseUrl) {
      return blockResult('KIMI_BASE_URL env var is required.');
    }

    const model = process.env.KIMI_MODEL?.trim() || 'kimi-k2.6';
    const repoPath = parentTask.repo_path;

    try {
      ensureClean(repoPath);
    } catch (cleanErr) {
      const msg = cleanErr instanceof Error ? cleanErr.message : String(cleanErr);
      return blockResult(`Working tree is not clean: ${msg}`);
    }

    const currentBranch = getCurrentBranch(repoPath);
    const safetyResult = validateRealRepoApplySafety(parentTask, {
      isClean: true,
      currentBranch,
    });
    if (!safetyResult.ok) {
      return blockResult(`Safety check failed: ${safetyResult.reason}`);
    }

    const fetchFn = buildFetchFnForFixTask();
    if (!fetchFn) {
      return blockResult('global fetch is not available and no fix-task fake response is configured.');
    }

    const fixTask: Task = {
      id: input.taskId,
      title: input.title,
      repo_path: repoPath,
      base_branch: parentTask.base_branch,
      work_branch: parentTask.work_branch,
      goal: input.goal,
      context_files: parentTask.context_files,
      checks: parentTask.checks,
      guardrails: parentTask.guardrails,
    };

    const previousHeadResult = spawnSync('git', ['rev-parse', '--verify', 'HEAD'], {
      cwd: repoPath,
      shell: false,
      encoding: 'utf-8',
    });
    const previousChangedFiles =
      previousHeadResult.status === 0
        ? getCommitChangedFiles(repoPath, previousHeadResult.stdout.trim())
        : [];

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
      const prompt = buildFixTaskPrompt(input, {
        parentGoal: parentTask.goal,
        allowedFiles: parentTask.guardrails.allow_modify ?? [],
        deniedFiles: parentTask.guardrails.deny_modify,
        previousChangedFiles,
        checks: parentTask.checks,
      });
      const providerInput = buildProviderCallInput('coder', prompt, 'kimi', model);
      const result = await realProviderCall(providerInput);
      const normalized = normalizeProviderCallResult(result);
      rawProviderText = normalized.text;
      kimiOutput = parseKimiOutputJson(rawProviderText);
    } catch (providerErr) {
      const info = normalizeProviderCallError(providerErr);
      return blockResult(`Provider call failed: ${info.message}`);
    }

    const updatePaths = kimiOutput.files.map((f) => f.path);

    const guardrailsResult = validateFileList(updatePaths, fixTask.guardrails);
    if (!guardrailsResult.ok) {
      return blockResult(`Guardrails failed: ${guardrailsResult.reason}`);
    }

    if (fixTask.guardrails.max_lines_changed !== undefined) {
      try {
        validateProposedFileLineDeltas(
          repoPath,
          kimiOutput.files,
          fixTask.guardrails.max_lines_changed
        );
      } catch (deltaErr) {
        const msg = deltaErr instanceof Error ? deltaErr.message : String(deltaErr);
        return blockResult(`Guardrails failed: ${msg}`);
      }
    }

    const sandboxRoot = mkdtempSync(join(tmpdir(), 'fix-task-preflight-'));
    try {
      const preflightResult = runRealRepoSandboxPreflight({
        task: fixTask,
        rawProviderText,
        sandboxRoot,
      });
      if (!preflightResult.ok) {
        return blockResult(
          `Sandbox preflight failed at step: ${preflightResult.failedStep ?? 'unknown'}`,
          [redactSecrets(preflightResult.logs)]
        );
      }
    } finally {
      if (existsSync(sandboxRoot)) {
        rmSync(sandboxRoot, { recursive: true, force: true });
      }
    }

    const existingPaths: string[] = [];
    for (const f of kimiOutput.files) {
      const filePath = join(repoPath, f.path);
      if (existsSync(filePath)) {
        existingPaths.push(f.path);
      }
    }

    const planResult = buildRealRepoApplyPlan({
      taskId: input.taskId,
      attempt: 1,
      existingPaths,
      files: kimiOutput.files,
    });

    if (!planResult.ok) {
      return blockResult(`Apply plan failed: ${planResult.reason}`);
    }

    let manifest: import('./types.js').PatchManifestEntry[] | undefined;
    try {
      manifest = applyFileUpdates(repoPath, kimiOutput.files, planResult.runDir);
    } catch (applyErr) {
      const msg = applyErr instanceof Error ? applyErr.message : String(applyErr);
      return blockResult(`Apply failed: ${msg}`);
    }

    const checkResult = runChecks(repoPath, fixTask.checks);
    if (!checkResult.success) {
      if (manifest && manifest.length > 0) {
        try {
          rollbackFileUpdates(repoPath, manifest);
        } catch (rollbackErr) {
          const msg = rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr);
          return blockResult(`Checks failed and rollback failed: ${redactSecrets(msg)}`, [
            redactSecrets(checkResult.logs),
          ]);
        }
      }
      return blockResult('Checks failed after applying fix.', [
        redactSecrets(checkResult.logs),
      ]);
    }

    const approvedPaths = new Set(updatePaths);
    const allChanges = getChangedFiles(repoPath);
    const unrelated = allChanges.filter((p) => !approvedPaths.has(p));
    if (unrelated.length > 0) {
      if (manifest && manifest.length > 0) {
        try {
          rollbackFileUpdates(repoPath, manifest);
        } catch (rollbackErr) {
          const msg = rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr);
          return blockResult(`Unrelated changes detected and rollback failed: ${redactSecrets(msg)}`);
        }
      }
      return blockResult(`Unrelated changes detected: ${unrelated.join(', ')}`);
    }

    if (allChanges.length === 0) {
      return blockResult('No working tree changes match the approved apply manifest.');
    }

    for (const p of allChanges.filter((p) => approvedPaths.has(p))) {
      const addResult = spawnSync('git', ['add', p], {
        cwd: repoPath,
        shell: false,
        encoding: 'utf-8',
      });
      if (addResult.status !== 0) {
        return blockResult(`Git add failed for ${p}`);
      }
    }

    const commitMessage = `ai-orchestrator: apply ${input.taskId}`;
    const commitResult = spawnSync(
      'git',
      ['commit', '-m', commitMessage, '--no-gpg-sign'],
      {
        cwd: repoPath,
        shell: false,
        encoding: 'utf-8',
      }
    );
    if (commitResult.status !== 0) {
      return blockResult(`Git commit failed: ${redactSecrets(commitResult.stderr)}`);
    }

    if (process.env.ALLOW_REAL_REPO_PUSH === 'true') {
      const pushResult = spawnSync(
        'git',
        ['push', 'origin', currentBranch],
        {
          cwd: repoPath,
          shell: false,
          encoding: 'utf-8',
        }
      );
      if (pushResult.status !== 0) {
        return blockResult(`Git push failed: ${redactSecrets(pushResult.stderr)}`);
      }
    }

    const headResult = spawnSync('git', ['rev-parse', '--verify', 'HEAD'], {
      cwd: repoPath,
      shell: false,
      encoding: 'utf-8',
    });
    if (headResult.status !== 0) {
      return blockResult('Failed to read fix commit SHA.');
    }
    const commitSha = headResult.stdout.trim();
    const changedFiles = getCommitChangedFiles(repoPath, commitSha);

    return {
      status: 'completed',
      reason: 'Fix task applied and committed.',
      commitSha,
      changedFiles,
      blockingIssues: [],
    };
  };
}

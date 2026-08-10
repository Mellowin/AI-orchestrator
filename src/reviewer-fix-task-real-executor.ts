import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Task, KimiOutput, ProviderAttempt, PatchManifestEntry, DependencyEvidencePackage } from './types.js';
import {
  createRealProviderCall,
  type FetchFn,
} from './provider-call.js';
import {
  validateFileList,
  validateProposedFileLineDeltas,
} from './guardrails.js';
import { validateAiSafetyPolicy } from './ai-safety-policy.js';
import { applyFileUpdates } from './patch-engine.js';
import {
  captureCheckpoint,
  rollbackToCheckpoint,
  type RepoCheckpoint,
} from './real-repo-rollback.js';
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
import type { ReviewerEvidenceInput } from './reviewer-evidence.js';
import {
  runCoderProviderPipeline,
  buildReviewerFixAttemptDir,
  type CoderProviderPipelineSuccess,
} from './coder-provider-pipeline.js';
import { writeProviderAttemptEvidence } from './provider-attempt-evidence.js';

export interface CreateReviewerFixTaskRealExecutorOptions {
  parentTask: Task;
}

function countLines(text: string): number {
  if (text.length === 0) return 0;
  const lines = text.split('\n');
  return text.endsWith('\n') ? lines.length - 1 : lines.length;
}

function classifyCheckCommand(command: string, args: string[]): string {
  const full = `${command} ${args.join(' ')}`.toLowerCase();
  if (full.includes('typecheck') || full.includes('tsc')) return 'typecheck';
  if (full.includes('build')) return 'build';
  if (full.includes('test')) return 'test';
  return 'other';
}

function buildFixCheckSummary(
  checks: Array<{ command: string; args: string[] }>,
  success: boolean
): ReviewerEvidenceInput['checkSummary'] {
  const hasTypecheck = checks.some((c) => classifyCheckCommand(c.command, c.args) === 'typecheck');
  const hasBuild = checks.some((c) => classifyCheckCommand(c.command, c.args) === 'build');
  const hasTest = checks.some((c) => classifyCheckCommand(c.command, c.args) === 'test');

  const summary: ReviewerEvidenceInput['checkSummary'] = {
    test: hasTest ? (success ? 'pass' : 'fail') : 'not_run',
  };

  summary.typecheck = hasTypecheck ? (success ? 'pass' : 'fail') : 'not_run';
  summary.build = hasBuild ? (success ? 'pass' : 'fail') : 'not_run';

  if (hasTest) {
    summary.tests = {
      total: checks.length,
      suites: 0,
      failures: success ? 0 : 1,
    };
  }

  return summary;
}

function resolveReviewerFixMaxAttempts(): number {
  const raw = process.env.REAL_REPO_REVIEWER_MAX_FIX_ATTEMPTS;
  if (raw === undefined || raw.trim() === '') {
    return 1;
  }
  const num = Number(raw.trim());
  if (!Number.isInteger(num) || num < 1 || num > 5) {
    throw new Error(`Invalid REAL_REPO_REVIEWER_MAX_FIX_ATTEMPTS: "${raw}". Must be an integer between 1 and 5.`);
  }
  return num;
}

export function buildFixTaskPrompt(
  input: ReviewerFixTaskExecutorInput,
  context: {
    parentGoal: string;
    allowedFiles: string[];
    deniedFiles: string[];
    previousChangedFiles: string[];
    checks: Array<{ command: string; args: string[] }>;
    currentHead: string;
    dependencyEvidence?: DependencyEvidencePackage;
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

  const dependencyEvidence = context.dependencyEvidence;
  const dependencySection =
    dependencyEvidence && dependencyEvidence.items.length > 0
      ? `# Dependency Evidence (read-only context from accepted ancestor tasks)\n` +
        `Total size: ${dependencyEvidence.total_bytes} bytes${dependencyEvidence.truncated ? ` (truncated; ${dependencyEvidence.omitted_count} item(s) omitted)` : ''}\n\n` +
        dependencyEvidence.items
          .map(
            (item) =>
              `- task: ${item.task_id} (${item.task_status})\n` +
              `  path: ${item.path}\n` +
              `  sha256: ${item.content_sha256}\n` +
              `  bytes: ${item.bytes}, lines: ${item.lines}${item.truncated ? ' [truncated]' : ''}\n` +
              `  content:\n\`\`\`\n${item.content}\n\`\`\``
          )
          .join('\n\n') +
        '\n\n'
      : dependencyEvidence
        ? `# Dependency Evidence\nNo accepted ancestor artifacts available.\n\n`
        : '';

  return (
    `# Reviewer Fix Task\n\n` +
    `Task ID: ${input.taskId}\n` +
    `Parent Task ID: ${input.parentTaskId}\n` +
    `Attempt: ${input.attempt}\n` +
    `Title: ${input.title}\n` +
    `Fix Task Goal: ${input.goal}\n` +
    `Original Parent Task Goal: ${context.parentGoal}\n` +
    `Current HEAD: ${context.currentHead}\n\n` +
    `# Blocking Issues to Address\n\n${blocking}\n\n` +
    `# Allowed Files\n\n${allowed}\n\n` +
    `# Denied Files\n\n${denied}\n\n` +
    `${dependencySection}` +
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

function buildFixTaskNoEffectRecoveryPrompt(
  input: ReviewerFixTaskExecutorInput,
  parentTask: Task,
  previousChangedFiles: string[],
  currentHead: string,
  classification: import('./kimi-output-classifier.js').KimiOutputClassification,
  classifiedFiles: import('./kimi-output-classifier.js').ClassifiedProposedFile[],
  attempt: number
): string {
  const previousPaths =
    classifiedFiles.length > 0
      ? classifiedFiles.map((f) => `${f.path} (${f.effect})`).join('\n')
      : '(none)';
  const allowedFiles = parentTask.guardrails.allow_modify ?? [];
  const deniedFiles = parentTask.guardrails.deny_modify;
  const maxLines = parentTask.guardrails.max_lines_changed;
  const blocking = input.blockingIssues.map((i) => `- ${i}`).join('\n');
  const previous = previousChangedFiles.map((f) => `- ${f}`).join('\n') || '(none)';

  return [
    'The previous fix-coder response was structurally valid but produced no actual changes.',
    `Classification: ${classification}`,
    `Previously proposed paths:`,
    previousPaths,
    '',
    `Parent Task ID: ${input.parentTaskId}`,
    `Fix Task ID: ${input.taskId}`,
    `Fix Attempt: ${attempt}`,
    `Original Parent Task Goal: ${parentTask.goal}`,
    `Fix Task Goal: ${input.goal}`,
    `Current HEAD: ${currentHead}`,
    '',
    '# Blocking Issues to Address',
    blocking,
    '',
    '# Allowed Files',
    allowedFiles.length > 0 ? allowedFiles.map((f) => `- ${f}`).join('\n') : '- No allowed files',
    '',
    '# Denied Files',
    deniedFiles.length > 0 ? deniedFiles.map((f) => `- ${f}`).join('\n') : '- No denied files',
    '',
    '# Files Changed by Initial Commit',
    previous,
    ...(maxLines !== undefined
      ? [
          '',
          '# Line Change Budget',
          `Advisory budget: prefer to keep any single file change under ${maxLines} lines.`,
        ]
      : []),
    '',
    'You must return a response that creates or modifies at least one file within the allowed scope.',
    'A new file with empty content still counts as a real change, but only if the task requires creating that file.',
    'Do not repeat the same identical content for files that already exist.',
    'Do not modify files outside the allowed scope.',
    'Do not modify already-completed dependency artifacts unless the fix task explicitly requires it.',
    '',
    'Return ONLY valid JSON matching the file_update schema with at least one effective file update.',
    'Use exactly this schema:',
    '',
    '{',
    '  "mode": "file_update",',
    '  "files": [',
    '    {',
    '      "path": "exact/allowed/path",',
    '      "content": "complete corrected file content"',
    '    }',
    '  ],',
    '  "notes": "optional"',
    '}',
  ].join('\n');
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
      if (content === '__AUTH_ERROR__') {
        return { ok: false, status: 401, json: async () => ({}) };
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
  blockingIssues: string[] = [],
  checkSummary?: ReviewerEvidenceInput['checkSummary']
): ReviewerFixTaskExecutorResult {
  return {
    status: 'blocked',
    reason: redactSecrets(reason),
    blockingIssues: blockingIssues.map((i) => redactSecrets(i)),
    checkSummary,
  };
}

function failedResult(
  checkpoint: RepoCheckpoint,
  reason: string,
  checkSummary?: ReviewerEvidenceInput['checkSummary'],
  extraBlockingIssues: string[] = []
): ReviewerFixTaskExecutorResult {
  const rollbackResult = rollbackToCheckpoint(checkpoint);
  return {
    status: 'failed',
    reason: redactSecrets(
      `${reason} (rollback_status=${rollbackResult.status} attempted=${rollbackResult.attempted} checkpointHead=${rollbackResult.checkpointHead})`
    ),
    baseCommitSha: checkpoint.headSha,
    blockingIssues: extraBlockingIssues.map((i) => redactSecrets(i)),
    checkSummary,
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

  const fetchFn = buildFetchFnForFixTask();

  return async (
    input: ReviewerFixTaskExecutorInput
  ): Promise<ReviewerFixTaskExecutorResult> => {
    const allowRealProvider =
      process.env.ALLOW_REAL_PROVIDER === 'true' || process.env.ALLOW_REAL_PROVIDER === '1';
    if (!allowRealProvider) {
      return blockResult('ALLOW_REAL_PROVIDER=true or ALLOW_REAL_PROVIDER=1 is required to execute reviewer fix task.');
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
    const currentHead = previousHeadResult.status === 0 ? previousHeadResult.stdout.trim() : '';

    const maxFixAttempts = resolveReviewerFixMaxAttempts();
    let providerAttempts: ProviderAttempt[] = [];
    let nextGlobalAttemptNumber = 1;
    let pipelineSuccess: CoderProviderPipelineSuccess | undefined;
    let currentPrompt = buildFixTaskPrompt(input, {
      parentGoal: parentTask.goal,
      allowedFiles: parentTask.guardrails.allow_modify ?? [],
      deniedFiles: parentTask.guardrails.deny_modify,
      previousChangedFiles,
      checks: parentTask.checks,
      currentHead,
      dependencyEvidence: parentTask.dependency_evidence,
    });

    for (let fixAttempt = 1; fixAttempt <= maxFixAttempts; fixAttempt++) {
      const realProviderCall = createRealProviderCall({
        provider: 'kimi',
        apiKey,
        baseUrl,
        fetchFn,
        model,
        userAgent: process.env.KIMI_USER_AGENT?.trim(),
      });

      const pipelineResult = await runCoderProviderPipeline({
        taskId: input.taskId,
        repoPath,
        basePrompt: currentPrompt,
        providerCall: realProviderCall,
        provider: 'kimi',
        model,
        providerAttemptType: 'reviewer_fix_coder',
        startingGlobalAttemptNumber: nextGlobalAttemptNumber,
        logPrefix: '[reviewer-fix-task]',
        buildAttemptDir: (_global, local) =>
          buildReviewerFixAttemptDir(parentTask.id, input.attempt, nextGlobalAttemptNumber + local - 1, local),
      });

      providerAttempts.push(...pipelineResult.providerAttempts);
      nextGlobalAttemptNumber = pipelineResult.nextGlobalAttemptNumber;

      if (!pipelineResult.success) {
        if (pipelineResult.isAuthError) {
          return blockResult(`Provider authentication failed: ${pipelineResult.reason}`);
        }
        return {
          status: 'failed',
          reason: redactSecrets(`Provider correction loop failed: ${pipelineResult.reason}`),
          blockingIssues: [],
        };
      }

      const classified = pipelineResult.classified;
      if (classified.classification === 'EMPTY_FILE_LIST' || classified.classification === 'ALL_IDENTICAL') {
        const lastAttempt = providerAttempts[providerAttempts.length - 1];
        if (lastAttempt) {
          lastAttempt.classification = classified.classification;
        }
        if (fixAttempt < maxFixAttempts) {
          currentPrompt = buildFixTaskNoEffectRecoveryPrompt(
            input,
            parentTask,
            previousChangedFiles,
            currentHead,
            classified.classification,
            classified.files,
            fixAttempt + 1
          );
          continue;
        }
        return {
          status: 'failed',
          reason: redactSecrets(
            `PROVIDER_NO_EFFECT_OUTPUT: ${classified.classification} after ${maxFixAttempts} fix attempt(s)`
          ),
          baseCommitSha: currentHead,
          blockingIssues: [],
        };
      }

      const lastAttempt = providerAttempts[providerAttempts.length - 1];
      if (lastAttempt) {
        lastAttempt.classification = 'EFFECTIVE_CHANGES';
      }
      pipelineSuccess = pipelineResult;
      break;
    }

    if (pipelineSuccess === undefined) {
      return {
        status: 'failed',
        reason: redactSecrets('No effective fix output was produced after all fix attempts.'),
        blockingIssues: [],
      };
    }

    const kimiOutput = pipelineSuccess.kimiOutput;
    const rawProviderText = pipelineSuccess.rawProviderText;
    const classified = pipelineSuccess.classified;

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

    const policyResult = validateAiSafetyPolicy({
      repoPath,
      allowedFiles: fixTask.guardrails.allow_modify,
      deniedFiles: fixTask.guardrails.deny_modify,
      files: kimiOutput.files,
    });
    if (!policyResult.ok) {
      return blockResult(`Safety policy violation: ${policyResult.reasons.join('; ')}`);
    }

    const sandboxRoot = mkdtempSync(join(tmpdir(), 'fix-task-preflight-'));
    try {
      const preflightResult = runRealRepoSandboxPreflight({
        task: fixTask,
        rawProviderText,
        sandboxRoot,
      });
      if (!preflightResult.ok) {
        const preflightCheckSummary =
          preflightResult.failedStep === 'checks'
            ? buildFixCheckSummary(fixTask.checks, false)
            : undefined;
        return blockResult(
          `Sandbox preflight failed at step: ${preflightResult.failedStep ?? 'unknown'}`,
          [redactSecrets(preflightResult.logs)],
          preflightCheckSummary
        );
      }
    } finally {
      if (existsSync(sandboxRoot)) {
        rmSync(sandboxRoot, { recursive: true, force: true });
      }
    }

    let checkpoint: RepoCheckpoint;
    try {
      checkpoint = captureCheckpoint(repoPath);
    } catch (cpErr) {
      const msg = cpErr instanceof Error ? cpErr.message : String(cpErr);
      return blockResult(`Failed to capture rollback checkpoint: ${msg}`);
    }

    function rollbackAndBlock(
      reason: string,
      blockingIssues: string[] = [],
      checkSummary?: ReviewerEvidenceInput['checkSummary']
    ): ReviewerFixTaskExecutorResult {
      const result = rollbackToCheckpoint(checkpoint);
      const rollbackInfo =
        `rollback_status=${result.status} attempted=${result.attempted} ` +
        `checkpointHead=${result.checkpointHead} finalHead=${result.finalHead ?? 'n/a'} ` +
        `policy=fix_attempt_rollback ` +
        `reason=${result.reason ?? 'none'}`;
      return blockResult(`${reason} (${rollbackInfo})`, blockingIssues, checkSummary);
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

    let manifest: PatchManifestEntry[] | undefined;
    try {
      manifest = applyFileUpdates(repoPath, kimiOutput.files, planResult.runDir);
    } catch (applyErr) {
      const msg = applyErr instanceof Error ? applyErr.message : String(applyErr);
      return rollbackAndBlock(`Apply failed: ${msg}`);
    }

    writeProviderAttemptEvidence({
      taskId: input.taskId,
      attempt: nextGlobalAttemptNumber - 1,
      repoPath,
      rawText: rawProviderText,
      kimiOutput,
      classified,
      phase: 'post-apply',
      manifest,
      attemptDir: pipelineSuccess.effectiveAttemptDir,
    });

    const checkResult = runChecks(repoPath, fixTask.checks);
    const fixCheckSummary = buildFixCheckSummary(fixTask.checks, checkResult.success);
    if (!checkResult.success) {
      return rollbackAndBlock(
        'Checks failed after applying fix.',
        [redactSecrets(checkResult.logs)],
        fixCheckSummary
      );
    }

    const approvedPaths = new Set(updatePaths);
    const allChanges = getChangedFiles(repoPath);
    const unrelated = allChanges.filter((p) => !approvedPaths.has(p));
    if (unrelated.length > 0) {
      return rollbackAndBlock(`Unrelated changes detected: ${unrelated.join(', ')}`);
    }

    if (allChanges.length === 0) {
      return failedResult(
        checkpoint,
        'No working tree changes match the approved apply manifest.'
      );
    }

    for (const p of allChanges.filter((p) => approvedPaths.has(p))) {
      const addResult = spawnSync('git', ['add', p], {
        cwd: repoPath,
        shell: false,
        encoding: 'utf-8',
      });
      if (addResult.status !== 0) {
        return failedResult(checkpoint, `Git add failed for ${p}`);
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
      return failedResult(checkpoint, `Git commit failed: ${redactSecrets(commitResult.stderr)}`);
    }

    const headResult = spawnSync('git', ['rev-parse', '--verify', 'HEAD'], {
      cwd: repoPath,
      shell: false,
      encoding: 'utf-8',
    });
    if (headResult.status !== 0) {
      return failedResult(checkpoint, 'Failed to read fix commit SHA.');
    }
    const commitSha = headResult.stdout.trim();
    const VALID_SHA = /^[0-9a-f]{40}$/i;
    if (!VALID_SHA.test(commitSha)) {
      return failedResult(checkpoint, 'Fix commit SHA is not a valid 40-character hex value.');
    }
    const changedFiles = getCommitChangedFiles(repoPath, commitSha);
    if (changedFiles.length === 0) {
      return failedResult(checkpoint, 'Fix commit has no changed files.');
    }

    return {
      status: 'completed',
      reason: 'Fix task applied and committed.',
      commitSha,
      baseCommitSha: checkpoint.headSha,
      changedFiles,
      blockingIssues: [],
      checkSummary: fixCheckSummary,
      providerAttempts,
    };
  };
}

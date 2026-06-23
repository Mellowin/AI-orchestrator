import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { isAbsolute, join, resolve } from 'node:path';
import YAML from 'yaml';
import { loadState, getRunDir } from './state-manager.js';
import { redactSecrets } from './sandbox-preflight-repair.js';
import type { RunState } from './types.js';

export interface PostPushFollowUpInput {
  taskId: string;
  reportOnly: boolean;
  followUpTaskId?: string;
  runsDir?: string;
}

export interface PostPushFollowUpResult {
  ok: boolean;
  report: string;
  followUpFilePath?: string;
  nextCommand?: string;
  exitCode: number;
}

const SAFE_ID_RE = /^[a-zA-Z0-9_-]+$/;
const MAIN_BRANCHES = new Set(['main', 'master']);
const SHA_RE = /^[0-9a-f]{40}$/;

function isObject(val: unknown): val is Record<string, unknown> {
  return typeof val === 'object' && val !== null && !Array.isArray(val);
}

function assertString(value: unknown): string {
  if (typeof value !== 'string') {
    throw new Error(`Expected string, got ${typeof value}`);
  }
  return value;
}

function validateTaskId(taskId: string): void {
  if (!taskId || !SAFE_ID_RE.test(taskId)) {
    throw new Error(
      `Invalid taskId: "${taskId}". Only letters, digits, hyphens and underscores are allowed.`
    );
  }
}

function runGit(cwd: string, args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync('git', args, { cwd, encoding: 'utf-8', shell: false });
  return {
    status: result.status ?? 1,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  };
}

function validateRepoPath(repoPath: string): void {
  if (!repoPath) {
    throw new Error('repo_path is missing');
  }
  if (!isAbsolute(repoPath)) {
    throw new Error(`repo_path must be absolute: ${repoPath}`);
  }
  const resolved = resolve(repoPath);
  if (!existsSync(resolved)) {
    throw new Error(`repo_path does not exist: ${repoPath}`);
  }
  if (!statSync(resolved).isDirectory()) {
    throw new Error(`repo_path is not a directory: ${repoPath}`);
  }
  if (!existsSync(join(resolved, '.git'))) {
    throw new Error(`repo_path is not a git repository: ${repoPath}`);
  }
}

function validateCommitSha(repoPath: string, sha: string): void {
  if (!sha) {
    throw new Error('Preserved commit SHA is missing');
  }
  if (!SHA_RE.test(sha)) {
    throw new Error(`Invalid commit SHA format: ${sha}`);
  }
  const verify = runGit(repoPath, ['cat-file', '-t', sha]);
  if (verify.status !== 0 || verify.stdout.trim() !== 'commit') {
    throw new Error(`Preserved commit SHA does not exist in repository: ${sha}`);
  }
}

function getReviewerGate(state: RunState): {
  status: string;
  blockingIssues: string[];
  reviewSummary: string;
  nextAction: string;
  fixTask?: string;
} | null {
  const s = state as unknown as Record<string, unknown>;
  const gate = s.reviewer_gate;
  if (!isObject(gate)) return null;
  const status = assertString(gate.status);
  return {
    status,
    blockingIssues: Array.isArray(gate.blockingIssues)
      ? gate.blockingIssues.map((i) => (typeof i === 'string' ? i : String(i)))
      : [],
    reviewSummary: typeof gate.reviewSummary === 'string' ? gate.reviewSummary : '',
    nextAction: typeof gate.nextAction === 'string' ? gate.nextAction : '',
    fixTask: typeof gate.fixTask === 'string' ? gate.fixTask : undefined,
  };
}

function getFixCommitSha(state: RunState): string | undefined {
  const s = state as unknown as Record<string, unknown>;
  const secondReview = s.reviewer_fix_task_second_review;
  if (isObject(secondReview) && typeof secondReview.fixCommitSha === 'string') {
    return secondReview.fixCommitSha;
  }
  return undefined;
}

function validatePostPushState(state: RunState, expectedTaskId: string): void {
  if (state.task_id !== expectedTaskId) {
    throw new Error(
      `State task_id mismatch: expected "${expectedTaskId}", got "${state.task_id}"`
    );
  }

  const s = state as unknown as Record<string, unknown>;

  const rollback = s.rollback;
  if (!isObject(rollback)) {
    throw new Error('State has no rollback record');
  }
  if (rollback.status !== 'skipped') {
    throw new Error(`Rollback status is ${String(rollback.status)}, expected skipped`);
  }
  if (rollback.policy !== 'post_push_preserve_for_human') {
    throw new Error(
      `Rollback policy is ${String(rollback.policy)}, expected post_push_preserve_for_human`
    );
  }

  const commitSha = typeof s.commit_sha === 'string' ? s.commit_sha : undefined;
  if (!commitSha) {
    throw new Error('State has no pushed commit_sha');
  }

  validateRepoPath(state.repo_path);

  if (MAIN_BRANCHES.has(state.branch)) {
    throw new Error(`Work branch is ${state.branch}; follow-up is not allowed on main/master`);
  }

  validateCommitSha(state.repo_path, commitSha);

  const gate = getReviewerGate(state);
  if (!gate) {
    throw new Error('State has no reviewer gate record');
  }
  if (gate.status === 'accepted') {
    throw new Error('Reviewer gate status is accepted; no human follow-up required');
  }

  const fixCommitSha = getFixCommitSha(state);
  if (fixCommitSha) {
    validateCommitSha(state.repo_path, fixCommitSha);
  }
}

function redactList(items: string[]): string[] {
  return items.map((item) => redactSecrets(item));
}

function buildReport(state: RunState): string {
  const s = state as unknown as Record<string, unknown>;
  const commitSha = assertString(s.commit_sha);
  const rollback = s.rollback as Record<string, unknown>;
  const gate = getReviewerGate(state);
  const fixCommitSha = getFixCommitSha(state);

  const lines: string[] = [];
  lines.push('[post-push-follow-up] Post-push manual follow-up summary');
  lines.push(`[post-push-follow-up] Task: ${state.task_id}`);
  lines.push(`[post-push-follow-up] Repository: ${state.repo_path}`);
  lines.push(`[post-push-follow-up] Work branch: ${state.branch}`);
  lines.push(`[post-push-follow-up] Preserved original commit: ${commitSha}`);
  if (fixCommitSha) {
    lines.push(`[post-push-follow-up] Preserved fix commit: ${fixCommitSha}`);
  }
  if (gate) {
    lines.push(`[post-push-follow-up] Reviewer decision: ${redactSecrets(gate.status)}`);
    lines.push(`[post-push-follow-up] Reviewer next action: ${redactSecrets(gate.nextAction)}`);
    if (gate.reviewSummary) {
      lines.push(`[post-push-follow-up] Reviewer summary: ${redactSecrets(gate.reviewSummary)}`);
    }
    if (gate.blockingIssues.length > 0) {
      lines.push('[post-push-follow-up] Blocking issues:');
      for (const issue of redactList(gate.blockingIssues)) {
        lines.push(`  - ${issue}`);
      }
    }
    if (gate.fixTask) {
      lines.push(`[post-push-follow-up] Fix task: ${redactSecrets(gate.fixTask)}`);
    }
  }
  lines.push(`[post-push-follow-up] Rollback status: ${String(rollback.status)}`);
  lines.push(`[post-push-follow-up] Rollback policy: ${String(rollback.policy)}`);
  lines.push(`[post-push-follow-up] Rollback reason: ${redactSecrets(String(rollback.reason ?? ''))}`);
  lines.push('[post-push-follow-up] Human follow-up required before merge');
  lines.push('[post-push-follow-up] No provider call was made');
  lines.push('[post-push-follow-up] No repository mutation was performed');

  return lines.join('\n');
}

function buildFollowUpTask(
  state: RunState,
  followUpTaskId: string
): {
  id: string;
  title: string;
  repo_path: string;
  base_branch: string;
  work_branch: string;
  goal: string;
  context_files: string[];
  checks: { command: string; args: string[] }[];
  guardrails: {
    deny_modify: string[];
    max_lines_changed: number;
    require_tests: boolean;
    auto_commit: boolean;
    auto_push: boolean;
    auto_merge: boolean;
  };
} {
  const gate = getReviewerGate(state);
  const blockingIssues = gate ? redactList(gate.blockingIssues) : [];
  const reviewSummary = gate ? redactSecrets(gate.reviewSummary) : '';
  const fixTask = gate && gate.fixTask ? redactSecrets(gate.fixTask) : '';

  const goalParts: string[] = [
    `Follow-up for task ${state.task_id} after post-push reviewer review.`,
  ];
  if (reviewSummary) {
    goalParts.push(`Reviewer summary: ${reviewSummary}`);
  }
  if (blockingIssues.length > 0) {
    goalParts.push(`Blocking issues: ${blockingIssues.join('; ')}`);
  }
  if (fixTask) {
    goalParts.push(`Requested fix: ${fixTask}`);
  }

  return {
    id: followUpTaskId,
    title: `Follow-up for ${state.task_id}`,
    repo_path: state.repo_path,
    base_branch: state.branch,
    work_branch: state.branch,
    goal: goalParts.join(' '),
    context_files: [],
    checks: [],
    guardrails: {
      deny_modify: ['.env', '.env.*', 'node_modules/**'],
      max_lines_changed: 150,
      require_tests: false,
      auto_commit: false,
      auto_push: false,
      auto_merge: false,
    },
  };
}

function writeFollowUpTaskFile(
  taskId: string,
  followUpTaskId: string,
  state: RunState,
  runsDir?: string
): string {
  const runDir = getRunDir(taskId, runsDir);
  if (!existsSync(runDir)) {
    mkdirSync(runDir, { recursive: true });
  }
  const filePath = join(runDir, `follow-up-${followUpTaskId}.yaml`);
  const task = buildFollowUpTask(state, followUpTaskId);
  const doc = { tasks: [task] };
  writeFileSync(filePath, YAML.stringify(doc), 'utf-8');
  return filePath;
}

export function runPostPushFollowUp(input: PostPushFollowUpInput): PostPushFollowUpResult {
  try {
    validateTaskId(input.taskId);

    const state = loadState(input.taskId, input.runsDir);
    if (!state) {
      throw new Error(`State file does not exist for task "${input.taskId}"`);
    }

    validatePostPushState(state, input.taskId);

    const report = buildReport(state);

    if (input.reportOnly) {
      return {
        ok: true,
        report,
        exitCode: 0,
      };
    }

    const followUpTaskId = input.followUpTaskId;
    if (!followUpTaskId) {
      throw new Error('--create-follow-up <newTaskId> is required unless --report-only is set');
    }
    validateTaskId(followUpTaskId);

    const filePath = writeFollowUpTaskFile(input.taskId, followUpTaskId, state, input.runsDir);
    const nextCommand = `TASKS_FILE="${filePath}" npx tsx src/cli.ts real-repo-run-ai ${followUpTaskId}`;

    return {
      ok: true,
      report,
      followUpFilePath: filePath,
      nextCommand,
      exitCode: 0,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      report: `[post-push-follow-up] Error: ${redactSecrets(message)}\n[post-push-follow-up] No provider call was made\n[post-push-follow-up] No repository mutation was performed`,
      exitCode: 1,
    };
  }
}

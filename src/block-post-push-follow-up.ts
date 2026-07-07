import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { isAbsolute, join, resolve } from 'node:path';
import YAML from 'yaml';
import { loadState, getRunDir } from './state-manager.js';
import { redactSecrets } from './sandbox-preflight-repair.js';
import { config } from './config.js';
import type { RealBlockRunState } from './real-block-run-ai-state.js';
import type { RunState } from './types.js';

export interface BlockPostPushFollowUpInput {
  blockId: string;
  createFollowUps: boolean;
  runsDir?: string;
}

export interface BlockPostPushFollowUpResult {
  ok: boolean;
  report: string;
  exitCode: number;
  followUpCount: number;
  followUpFilePaths?: string[];
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

function validateBlockId(blockId: string): void {
  if (!blockId || !SAFE_ID_RE.test(blockId)) {
    throw new Error(
      `Invalid blockId: "${blockId}". Only letters, digits, hyphens and underscores are allowed.`
    );
  }
}

function getRunsDir(input?: string): string {
  return resolve(input ?? process.env.RUNS_DIR ?? config.runsDir);
}

function getBlockStatePath(runsDir: string, blockId: string): string {
  return join(runsDir, 'block', blockId, 'state.json');
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

function loadBlockRunState(blockId: string, runsDir: string): RealBlockRunState {
  const statePath = getBlockStatePath(runsDir, blockId);
  if (!existsSync(statePath)) {
    throw new Error(`Block state file does not exist: ${statePath}`);
  }

  let raw: string;
  try {
    raw = readFileSync(statePath, 'utf-8');
  } catch {
    throw new Error('Block state file could not be read');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('Block state file is not valid JSON');
  }

  if (!isObject(parsed)) {
    throw new Error('Block state file is not a valid object');
  }
  if (parsed.block_id !== blockId) {
    throw new Error(
      `Block id mismatch: expected "${blockId}", got "${String(parsed.block_id)}"`
    );
  }
  if (!Array.isArray(parsed.taskResults)) {
    throw new Error('Block state has invalid taskResults');
  }

  return parsed as unknown as RealBlockRunState;
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

function redactList(items: string[]): string[] {
  return items.map((item) => redactSecrets(item));
}

function validatePostPushState(state: RunState): void {
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

interface FollowUpItem {
  taskId: string;
  childStateTaskId: string;
  state: RunState;
  originalCommitSha: string;
  fixCommitSha?: string;
}

function gatherFollowUpItems(
  blockState: RealBlockRunState,
  runsDir: string
): FollowUpItem[] {
  const items: FollowUpItem[] = [];

  for (const result of blockState.taskResults) {
    if (result.rollbackPolicy !== 'post_push_preserve_for_human') {
      continue;
    }

    const childStateTaskId = result.childStateTaskId;
    if (!childStateTaskId || !SAFE_ID_RE.test(childStateTaskId)) {
      throw new Error(`Invalid childStateTaskId for task "${result.taskId}"`);
    }

    // Child real-repo-run-ai state lives under runs/tasks/<task_id>.
    const state = loadState(childStateTaskId, join(runsDir, 'tasks'));
    if (!state) {
      throw new Error(
        `State file does not exist for task "${childStateTaskId}"`
      );
    }

    validatePostPushState(state);

    const originalCommitSha =
      typeof result.originalCommitSha === 'string' && result.originalCommitSha.length === 40
        ? result.originalCommitSha
        : (state as unknown as Record<string, unknown>).commit_sha as string;

    if (originalCommitSha !== (state as unknown as Record<string, unknown>).commit_sha) {
      throw new Error(
        `Original commit SHA mismatch for task "${result.taskId}": block state has ${originalCommitSha}, child state has ${String((state as unknown as Record<string, unknown>).commit_sha)}`
      );
    }

    const fixCommitSha =
      typeof result.fixCommitSha === 'string' && result.fixCommitSha.length === 40
        ? result.fixCommitSha
        : getFixCommitSha(state);

    if (fixCommitSha) {
      validateCommitSha(state.repo_path, fixCommitSha);
    }

    items.push({
      taskId: result.taskId,
      childStateTaskId,
      state,
      originalCommitSha,
      fixCommitSha,
    });
  }

  return items;
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
    allow_modify?: string[];
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
  childStateTaskId: string,
  followUpTaskId: string,
  state: RunState,
  runsDir: string
): string {
  const runDir = getRunDir(childStateTaskId, runsDir);
  if (!existsSync(runDir)) {
    mkdirSync(runDir, { recursive: true });
  }
  const filePath = join(runDir, `follow-up-${followUpTaskId}.yaml`);
  const task = buildFollowUpTask(state, followUpTaskId);
  const doc = { tasks: [task] };
  writeFileSync(filePath, YAML.stringify(doc), 'utf-8');
  return filePath;
}

function buildReport(blockState: RealBlockRunState, items: FollowUpItem[]): string {
  const lines: string[] = [];
  const prefix = '[block-post-push-follow-up]';

  lines.push(`${prefix} Post-push manual follow-up summary for block "${blockState.block_id}"`);
  lines.push(`${prefix} Tasks needing human follow-up: ${items.length}`);

  if (items.length === 0) {
    lines.push(`${prefix} No tasks require post-push human follow-up.`);
  } else {
    for (const item of items) {
      const state = item.state;
      const rollback = (state as unknown as Record<string, unknown>).rollback as Record<string, unknown>;
      const gate = getReviewerGate(state);
      lines.push('');
      lines.push(`${prefix} Task: ${item.taskId}`);
      lines.push(`${prefix}   Original commit: ${item.originalCommitSha}`);
      if (item.fixCommitSha) {
        lines.push(`${prefix}   Fix commit: ${item.fixCommitSha}`);
      }
      lines.push(`${prefix}   Repository: ${state.repo_path}`);
      lines.push(`${prefix}   Work branch: ${state.branch}`);
      lines.push(`${prefix}   Rollback policy: ${String(rollback.policy)}`);
      lines.push(`${prefix}   Rollback reason: ${redactSecrets(String(rollback.reason ?? ''))}`);
      if (gate) {
        lines.push(`${prefix}   Reviewer decision: ${redactSecrets(gate.status)}`);
        lines.push(`${prefix}   Reviewer next action: ${redactSecrets(gate.nextAction)}`);
        if (gate.reviewSummary) {
          lines.push(`${prefix}   Reviewer summary: ${redactSecrets(gate.reviewSummary)}`);
        }
        if (gate.blockingIssues.length > 0) {
          lines.push(`${prefix}   Blocking issues:`);
          for (const issue of redactList(gate.blockingIssues)) {
            lines.push(`${prefix}     - ${issue}`);
          }
        }
        if (gate.fixTask) {
          lines.push(`${prefix}   Fix task: ${redactSecrets(gate.fixTask)}`);
        }
      }
      lines.push(`${prefix}   Recommended next steps:`);
      lines.push(`${prefix}     npx tsx src/cli.ts real-repo-follow-up ${item.childStateTaskId} --report-only`);
      lines.push(`${prefix}     npx tsx src/cli.ts real-repo-follow-up ${item.childStateTaskId} --create-follow-up ${item.childStateTaskId}-follow-up`);
    }
  }

  lines.push('');
  lines.push(`${prefix} Human review required before merge`);
  lines.push(`${prefix} No provider call was made`);
  lines.push(`${prefix} No repository mutation was performed`);

  return lines.join('\n');
}

export function runBlockPostPushFollowUp(
  input: BlockPostPushFollowUpInput
): BlockPostPushFollowUpResult {
  try {
    validateBlockId(input.blockId);
    const runsDir = getRunsDir(input.runsDir);
    const blockState = loadBlockRunState(input.blockId, runsDir);

    const items = gatherFollowUpItems(blockState, runsDir);
    const report = buildReport(blockState, items);

    if (!input.createFollowUps) {
      return {
        ok: items.length === 0 || items.length > 0,
        report,
        exitCode: 0,
        followUpCount: items.length,
      };
    }

    const followUpFilePaths: string[] = [];
    for (const item of items) {
      const followUpTaskId = `${item.childStateTaskId}-follow-up`;
      const filePath = writeFollowUpTaskFile(
        item.childStateTaskId,
        followUpTaskId,
        item.state,
        runsDir
      );
      followUpFilePaths.push(filePath);
    }

    return {
      ok: true,
      report,
      exitCode: 0,
      followUpCount: items.length,
      followUpFilePaths,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const prefix = '[block-post-push-follow-up]';
    return {
      ok: false,
      report: `${prefix} Error: ${redactSecrets(message)}\n${prefix} No provider call was made\n${prefix} No repository mutation was performed`,
      exitCode: 1,
      followUpCount: 0,
    };
  }
}


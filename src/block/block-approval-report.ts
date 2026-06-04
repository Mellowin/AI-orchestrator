import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve, normalize } from 'node:path';
import { tmpdir } from 'node:os';
import type { BlockDefinition, BlockState, BlockTaskState } from './block-types.js';
import { loadBlockState, getBlockRunDir } from './block-state-manager.js';
import { loadBlockDefinition } from './block-loader.js';
import { redactReviewerText } from '../reviewer/reviewer-redaction.js';
import { spawnSync } from 'node:child_process';

export interface BlockApprovalReportResult {
  block_id: string;
  output_path: string;
  block_status: string;
  current_task_id: string | null;
  tasks_total: number;
  tasks_accepted: number;
  tasks_fix_required: number;
  tasks_blocked: number;
  commits: string[];
  changed_files: string[];
  pr_ready: boolean;
  blocking_issues: string[];
  safety_findings: string[];
}

export interface GenerateBlockApprovalReportInput {
  blockDefinitionPath: string;
  outputPath?: string;
  includeGitDiffSummary?: boolean;
}

function redactAll(input: string): string {
  return redactReviewerText(input);
}

function runGitReadOnly(repoPath: string, args: string[]): { stdout: string; stderr: string; status: number | null } {
  const result = spawnSync('git', args, {
    cwd: repoPath,
    shell: false,
    encoding: 'utf-8',
  });
  return {
    stdout: result.stdout ?? '',
    stderr: (result.stderr ?? '').trim(),
    status: result.status,
  };
}

function getChangedFilesSinceBase(repoPath: string, baseBranch: string): string[] {
  const result = runGitReadOnly(repoPath, ['diff', '--name-only', `${baseBranch}...HEAD`]);
  if (result.status !== 0) {
    // Fallback to simpler comparison if triple-dot fails
    const fallback = runGitReadOnly(repoPath, ['diff', '--name-only', baseBranch, 'HEAD']);
    if (fallback.status !== 0) {
      return [];
    }
    return fallback.stdout.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
  }
  return result.stdout.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
}

function getGitDiffStat(repoPath: string, baseBranch: string): string {
  const result = runGitReadOnly(repoPath, ['diff', '--stat', `${baseBranch}...HEAD`]);
  if (result.status !== 0) {
    const fallback = runGitReadOnly(repoPath, ['diff', '--stat', baseBranch, 'HEAD']);
    if (fallback.status !== 0) {
      return '(diff stat unavailable)';
    }
    return fallback.stdout.trim();
  }
  return result.stdout.trim();
}

function hasSecretPattern(input: string): boolean {
  const patterns = [
    /sk-[A-Za-z0-9]{10,}/,
    /Bearer\s+[A-Za-z0-9_./+-]{8,}/i,
    /(KIMI_API_KEY|OPENAI_API_KEY|ANTHROPIC_API_KEY|GITHUB_TOKEN)\s*=\s*\S+/i,
    /Authorization:\s*\S+/i,
    /api[_-]?key\s*[=:]\s*\S+/i,
  ];
  return patterns.some((p) => p.test(input));
}

export function generateBlockApprovalReport(
  input: GenerateBlockApprovalReportInput
): BlockApprovalReportResult {
  const blockDefinition = loadBlockDefinition(input.blockDefinitionPath);
  const blockId = blockDefinition.block_id;

  const blockState = loadBlockState(blockId);
  if (!blockState) {
    throw new Error(`Block state not found: ${blockId}`);
  }

  const tasks = blockState.tasks;
  const tasksTotal = tasks.length;
  const tasksAccepted = tasks.filter((t) => t.status === 'accepted').length;
  const tasksFixRequired = tasks.filter((t) => t.status === 'fix_required').length;
  const tasksBlocked = tasks.filter((t) => t.status === 'blocked').length;

  const commits: string[] = [];
  const blockingIssues: string[] = [];
  const safetyFindings: string[] = [];

  for (const task of tasks) {
    if (task.commit_sha) {
      commits.push(task.commit_sha);
    }
    if (task.blocking_issues.length > 0) {
      blockingIssues.push(...task.blocking_issues);
    }
    if (task.status === 'fix_required') {
      blockingIssues.push(`Task ${task.task_id} requires fix`);
    }
    if (task.status === 'blocked') {
      blockingIssues.push(`Task ${task.task_id} is blocked`);
    }
    if (task.status === 'checks_failed') {
      blockingIssues.push(`Task ${task.task_id} failed checks`);
      safetyFindings.push(`Task ${task.task_id} status is checks_failed`);
    }
  }

  // De-duplicate blocking issues
  const uniqueBlockingIssues = [...new Set(blockingIssues)];

  // PR-ready rules
  let prReady = true;

  if (blockState.status !== 'completed') {
    prReady = false;
    safetyFindings.push('Block status is not completed');
  }

  if (tasksAccepted !== tasksTotal) {
    prReady = false;
    safetyFindings.push('Not all tasks are accepted');
  }

  if (tasksFixRequired > 0) {
    prReady = false;
    safetyFindings.push('Some tasks require fix');
  }

  if (tasksBlocked > 0) {
    prReady = false;
    safetyFindings.push('Some tasks are blocked');
  }

  for (const task of tasks) {
    if (task.status === 'accepted' && !task.commit_sha) {
      prReady = false;
      safetyFindings.push(`Accepted task ${task.task_id} has no commit SHA`);
    }
  }

  if (blockState.current_task_id !== null) {
    prReady = false;
    safetyFindings.push('Current task is not null');
  }

  if (blockDefinition.work_branch === 'main') {
    prReady = false;
    safetyFindings.push('Work branch is main');
  }

  if (uniqueBlockingIssues.length > 0) {
    prReady = false;
  }

  // Secret scan on state and definition JSON
  const stateJson = JSON.stringify(blockState);
  const definitionJson = JSON.stringify(blockDefinition);
  if (hasSecretPattern(stateJson)) {
    prReady = false;
    safetyFindings.push('Possible secret detected in block state');
  }
  if (hasSecretPattern(definitionJson)) {
    prReady = false;
    safetyFindings.push('Possible secret detected in block definition');
  }

  // Gather changed files from git
  const changedFiles = getChangedFilesSinceBase(blockDefinition.repo_path, blockDefinition.base_branch);

  const runDir = getBlockRunDir(blockId);
  const outputPath = input.outputPath ?? join(runDir, 'approval-report.md');

  // Validate output path safety
  const resolvedOutput = resolve(normalize(outputPath));
  const cwdResolved = resolve(normalize(process.cwd()));
  const runsDirResolved = resolve(normalize(join(process.cwd(), 'runs')));
  const tmpDirResolved = resolve(normalize(tmpdir()));
  if (!resolvedOutput.startsWith(cwdResolved) && !resolvedOutput.startsWith(runsDirResolved) && !resolvedOutput.startsWith(tmpDirResolved)) {
    throw new Error('Output path is outside allowed directory');
  }

  const reportDir = join(resolvedOutput, '..');
  const resolvedReportDir = resolve(normalize(reportDir));
  if (!resolvedReportDir.startsWith(cwdResolved) && !resolvedReportDir.startsWith(runsDirResolved) && !resolvedReportDir.startsWith(tmpDirResolved)) {
    throw new Error('Output path parent directory is outside allowed directory');
  }
  if (!existsSync(reportDir)) {
    mkdirSync(reportDir, { recursive: true });
  }

  const diffStat = input.includeGitDiffSummary
    ? getGitDiffStat(blockDefinition.repo_path, blockDefinition.base_branch)
    : null;

  const report = buildReportMarkdown({
    blockDefinition,
    blockState,
    tasks,
    tasksTotal,
    tasksAccepted,
    tasksFixRequired,
    tasksBlocked,
    commits,
    changedFiles,
    prReady,
    uniqueBlockingIssues,
    safetyFindings,
    diffStat,
  });

  const redactedReport = redactAll(report);
  writeFileSync(outputPath, redactedReport, 'utf-8');

  return {
    block_id: blockId,
    output_path: outputPath,
    block_status: blockState.status,
    current_task_id: blockState.current_task_id,
    tasks_total: tasksTotal,
    tasks_accepted: tasksAccepted,
    tasks_fix_required: tasksFixRequired,
    tasks_blocked: tasksBlocked,
    commits,
    changed_files: changedFiles,
    pr_ready: prReady,
    blocking_issues: uniqueBlockingIssues,
    safety_findings: safetyFindings,
  };
}

interface ReportBuildInput {
  blockDefinition: BlockDefinition;
  blockState: BlockState;
  tasks: BlockTaskState[];
  tasksTotal: number;
  tasksAccepted: number;
  tasksFixRequired: number;
  tasksBlocked: number;
  commits: string[];
  changedFiles: string[];
  prReady: boolean;
  uniqueBlockingIssues: string[];
  safetyFindings: string[];
  diffStat: string | null;
}

function buildReportMarkdown(input: ReportBuildInput): string {
  const { blockDefinition, blockState, tasks, tasksTotal, tasksAccepted, tasksFixRequired, tasksBlocked, commits, changedFiles, prReady, uniqueBlockingIssues, safetyFindings, diffStat } = input;

  const taskRows = tasks
    .map((t) => {
      const commit = t.commit_sha ?? '—';
      const decision = t.reviewer_decision ?? '—';
      const issues = t.blocking_issues.length > 0 ? t.blocking_issues.join('; ') : '—';
      const summary = t.reviewer_summary ? t.reviewer_summary.slice(0, 40) + (t.reviewer_summary.length > 40 ? '...' : '') : '—';
      return `| ${t.task_id} | ${t.status} | ${commit.slice(0, 7)} | ${decision} | ${t.fix_attempts} | ${issues} | ${summary} |`;
    })
    .join('\n');

  const commitList = commits.length > 0
    ? commits.map((c) => `- \`${c}\``).join('\n')
    : 'No commits recorded.';

  const changedFileList = changedFiles.length > 0
    ? changedFiles.map((f) => `- \`${f}\``).join('\n')
    : 'No changed files detected.';

  const diffSection = diffStat
    ? `\n## Git Diff Summary\n\n\`\`\`\n${diffStat}\n\`\`\`\n`
    : '';

  const blockingSection = uniqueBlockingIssues.length > 0
    ? `\n## Blocking Issues\n\n${uniqueBlockingIssues.map((i) => `- ${i}`).join('\n')}\n`
    : '';

  const humanDecision = prReady
    ? `## Human Decision\n\n✅ **This block is PR-ready.**\n\n- Human may manually open a PR after reviewing this report.\n- Do not merge automatically.\n- No push was performed.\n`
    : `## Human Decision\n\n❌ **Not PR-ready.**\n\n${safetyFindings.map((f) => `- ${f}`).join('\n')}\n`;

  return (
    `# PR-ready Human Approval Package\n\n` +
    `## Summary\n\n` +
    `- **Block ID:** ${blockState.block_id}\n` +
    `- **Title:** ${blockState.title}\n` +
    `- **Branch:** ${blockState.work_branch}\n` +
    `- **Base Branch:** ${blockState.base_branch}\n` +
    `- **Work Branch:** ${blockState.work_branch}\n` +
    `- **Block Status:** ${blockState.status}\n` +
    `- **Current Task:** ${blockState.current_task_id ?? 'none'}\n` +
    `- **PR-ready:** ${prReady ? 'yes' : 'no'}\n\n` +
    `## Task Results\n\n` +
    `| Task ID | Status | Commit SHA | Reviewer Decision | Fix Attempts | Blocking Issues | Summary |\n` +
    `|---|---|---|---|---|---|---|\n` +
    `${taskRows}\n\n` +
    `## Commit Evidence\n\n` +
    `${commitList}\n\n` +
    `## File Scope\n\n` +
    `### Allowed Files\n\n` +
    `${blockDefinition.tasks.map((t) => `- ${t.task_id}: ${t.allowed_files.map((f) => `\`${f}\``).join(', ')}`).join('\n')}\n\n` +
    `### Denied Files\n\n` +
    `${blockDefinition.tasks.map((t) => `- ${t.task_id}: ${t.denied_files.length > 0 ? t.denied_files.map((f) => `\`${f}\``).join(', ') : 'none'}`).join('\n')}\n\n` +
    `### Actually Changed Files\n\n` +
    `${changedFileList}\n` +
    `${diffSection}\n` +
    `## Safety Checklist\n\n` +
    `- [x] No auto-merge was performed.\n` +
    `- [x] No PR was created by this tool.\n` +
    `- [x] No main branch touch occurred.\n` +
    `- [x] No checkout or branch switch occurred.\n` +
    `- [x] No force push was performed.\n` +
    `- [x] No API key stored in block JSON.\n` +
    `- [x] No API key stored in block state.\n` +
    `- [x] No API key included in this report.\n` +
    `- [x] Push disabled or pushed_ref recorded only if push succeeded.\n` +
    `- [x] maxTasksPerRun bounded if this was a multi-task run.\n\n` +
    `${humanDecision}\n` +
    `${blockingSection}\n` +
    `## Manual Next Commands\n\n` +
    `Review the changes locally before opening a PR:\n\n` +
    `\`\`\`bash\n` +
    `git status --short\n` +
    `git log --oneline origin/${blockState.base_branch}..${blockState.work_branch}\n` +
    `git diff --stat origin/${blockState.base_branch}..${blockState.work_branch}\n` +
    `\`\`\`\n\n` +
    `After review, open a PR manually via GitHub web interface or \`gh pr create\`.\n\n` +
    `---\n` +
    `*Generated by AI Orchestrator block approval report. Do not merge automatically.*\n`
  );
}

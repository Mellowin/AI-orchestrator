import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join, resolve, normalize } from 'node:path';
import { spawnSync } from 'node:child_process';
import type { BlockDefinition, BlockState } from './block-types.js';
import { loadBlockState, getBlockRunDir } from './block-state-manager.js';
import { loadBlockDefinition } from './block-loader.js';
import { analyzeBlockForPrReadiness } from './block-approval-report.js';

export interface BlockPrCreateResult {
  block_id: string;
  dry_run: boolean;
  pr_created: boolean;
  pr_number: number | null;
  pr_url: string | null;
  base_branch: string;
  work_branch: string;
  title: string;
  body_path: string;
  draft_dir: string;
  commit_shas: string[];
  blocking_issues: string[];
  safety_findings: string[];
  output_path: string | null;
}

export interface CreateBlockPullRequestInput {
  blockDefinitionPath: string;
  draftDir?: string;
  dryRun?: boolean;
  fetchFn?: typeof fetch;
}

function getEnv(name: string): string | undefined {
  return process.env[name]?.trim();
}

function validateRepositoryFormat(repo: string): { owner: string; repo: string } {
  const parts = repo.split('/');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error('GITHUB_REPOSITORY must be in owner/repo format');
  }
  return { owner: parts[0], repo: parts[1] };
}

function readPrDraftFiles(draftDir: string): { title: string; body: string; checklist: string } {
  const titlePath = join(draftDir, 'pr-title.txt');
  const bodyPath = join(draftDir, 'pr-body.md');
  const checklistPath = join(draftDir, 'manual-pr-checklist.md');

  if (!existsSync(titlePath)) {
    throw new Error(`PR draft title missing: ${titlePath}`);
  }
  if (!existsSync(bodyPath)) {
    throw new Error(`PR draft body missing: ${bodyPath}`);
  }
  if (!existsSync(checklistPath)) {
    throw new Error(`PR draft checklist missing: ${checklistPath}`);
  }

  return {
    title: readFileSync(titlePath, 'utf-8'),
    body: readFileSync(bodyPath, 'utf-8'),
    checklist: readFileSync(checklistPath, 'utf-8'),
  };
}

function hasObviousSecret(input: string): boolean {
  const patterns = [
    /sk-[A-Za-z0-9]{10,}/,
    /Bearer\s+[A-Za-z0-9_./+-]{8,}/i,
    /KIMI_API_KEY/i,
    /GITHUB_TOKEN/i,
    /Authorization:/i,
    /apiKey/i,
    /api_key/i,
  ];
  return patterns.some((p) => p.test(input));
}

export function checkBranchPushed(repoPath: string, workBranch: string): boolean {
  const result = spawnSync('git', ['ls-remote', '--heads', 'origin', workBranch], {
    cwd: repoPath,
    shell: false,
    encoding: 'utf-8',
  });
  if (result.status !== 0) {
    return false;
  }
  const lines = result.stdout.split('\n').filter((l) => l.trim().length > 0);
  return lines.some((l) => l.includes(`refs/heads/${workBranch}`));
}

export async function checkExistingOpenPr(
  owner: string,
  repo: string,
  workBranch: string,
  token: string,
  fetchFn: typeof fetch
): Promise<{ number: number; html_url: string } | null> {
  const url = `https://api.github.com/repos/${owner}/${repo}/pulls?head=${encodeURIComponent(owner)}:${encodeURIComponent(workBranch)}&state=open`;
  const response = await fetchFn(url, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (!response.ok) {
    return null;
  }
  const data = (await response.json()) as Array<{ number: number; html_url: string }>;
  if (Array.isArray(data) && data.length > 0) {
    return { number: data[0].number, html_url: data[0].html_url };
  }
  return null;
}

export async function createGitHubPr(
  owner: string,
  repo: string,
  payload: { title: string; body: string; head: string; base: string; draft: boolean },
  token: string,
  fetchFn: typeof fetch
): Promise<{ number: number; html_url: string }> {
  const url = `https://api.github.com/repos/${owner}/${repo}/pulls`;
  const response = await fetchFn(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`GitHub API error ${response.status}: ${text.slice(0, 200)}`);
  }
  const data = (await response.json()) as { number: number; html_url: string };
  if (typeof data.number !== 'number' || !data.html_url) {
    throw new Error('GitHub API response missing PR number or URL');
  }
  return { number: data.number, html_url: data.html_url };
}

export async function createBlockPullRequest(
  input: CreateBlockPullRequestInput
): Promise<BlockPrCreateResult> {
  const allowBlockPrCreate = getEnv('ALLOW_BLOCK_PR_CREATE') === 'true';
  const allowGithubPrCreate = getEnv('ALLOW_GITHUB_PR_CREATE') === 'true';
  const token = getEnv('GITHUB_TOKEN');
  const repository = getEnv('GITHUB_REPOSITORY');
  const allowWithoutApprovalReport = getEnv('ALLOW_PR_CREATE_WITHOUT_APPROVAL_REPORT') === 'true';
  const allowDuplicate = getEnv('ALLOW_BLOCK_PR_CREATE_DUPLICATE') === 'true';
  const isDryRun = input.dryRun === true || getEnv('BLOCK_PR_CREATE_DRY_RUN') === 'true';
  const fetchFn = input.fetchFn ?? globalThis.fetch;

  if (!allowBlockPrCreate) {
    throw new Error('ALLOW_BLOCK_PR_CREATE=true is required');
  }
  if (!allowGithubPrCreate) {
    throw new Error('ALLOW_GITHUB_PR_CREATE=true is required');
  }
  if (!token) {
    throw new Error('GITHUB_TOKEN is required');
  }
  if (!repository) {
    throw new Error('GITHUB_REPOSITORY is required');
  }

  const { owner, repo } = validateRepositoryFormat(repository);

  const blockDefinition = loadBlockDefinition(input.blockDefinitionPath);
  const blockId = blockDefinition.block_id;
  const runDir = getBlockRunDir(blockId);

  const blockState = loadBlockState(blockId);
  if (!blockState) {
    throw new Error(`Block state not found: ${blockId}`);
  }

  const analysis = analyzeBlockForPrReadiness(blockDefinition, blockState);
  const safetyFindings = [...analysis.safetyFindings];
  const blockingIssues = [...analysis.uniqueBlockingIssues];

  if (blockState.status !== 'completed') {
    throw new Error('Block status must be completed to create PR');
  }
  if (blockState.current_task_id !== null) {
    throw new Error('Current task must be null to create PR');
  }
  if (analysis.tasksFixRequired > 0) {
    throw new Error('Some tasks require fix');
  }
  if (analysis.tasksBlocked > 0) {
    throw new Error('Some tasks are blocked');
  }
  if (analysis.tasksAccepted !== analysis.tasksTotal) {
    throw new Error('Not all tasks are accepted');
  }

  for (const task of blockState.tasks) {
    if (task.status === 'accepted' && !task.commit_sha) {
      throw new Error(`Accepted task ${task.task_id} has no commit SHA`);
    }
    if (task.status === 'accepted' && !task.pushed_ref) {
      throw new Error(`Accepted task ${task.task_id} has no pushed_ref`);
    }
  }

  if (blockDefinition.work_branch === 'main') {
    throw new Error('Work branch cannot be main');
  }
  if (blockDefinition.base_branch === blockDefinition.work_branch) {
    throw new Error('Base branch cannot equal work branch');
  }

  const approvalReportPath = join(runDir, 'approval-report.md');
  if (!existsSync(approvalReportPath) && !allowWithoutApprovalReport) {
    throw new Error(
      'Approval report not found. Generate it first or set ALLOW_PR_CREATE_WITHOUT_APPROVAL_REPORT=true'
    );
  }

  const draftDir = input.draftDir ?? join(runDir, 'pr-draft');
  let title: string;
  let body: string;
  try {
    const drafts = readPrDraftFiles(draftDir);
    title = drafts.title;
    body = drafts.body;
  } catch (err) {
    throw new Error(
      `PR draft package incomplete: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  if (body.includes('NOT PR-READY') || body.includes('DO NOT OPEN PR YET')) {
    throw new Error('PR body indicates block is not PR-ready');
  }
  if (hasObviousSecret(title)) {
    throw new Error('PR title contains possible secret');
  }
  if (hasObviousSecret(body)) {
    throw new Error('PR body contains possible secret');
  }

  const branchPushed = checkBranchPushed(blockDefinition.repo_path, blockDefinition.work_branch);
  if (!branchPushed) {
    throw new Error('Work branch is not pushed. Push manually first.');
  }

  const prCreatedPath = join(runDir, 'pr-created.json');
  if (existsSync(prCreatedPath) && !allowDuplicate) {
    throw new Error(
      'PR already created for this block. Set ALLOW_BLOCK_PR_CREATE_DUPLICATE=true to override.'
    );
  }

  if (!isDryRun) {
    const existingPr = await checkExistingOpenPr(owner, repo, blockDefinition.work_branch, token, fetchFn);
    if (existingPr) {
      return {
        block_id: blockId,
        dry_run: false,
        pr_created: false,
        pr_number: existingPr.number,
        pr_url: existingPr.html_url,
        base_branch: blockDefinition.base_branch,
        work_branch: blockDefinition.work_branch,
        title,
        body_path: join(draftDir, 'pr-body.md'),
        draft_dir: draftDir,
        commit_shas: analysis.commits,
        blocking_issues: blockingIssues,
        safety_findings: safetyFindings,
        output_path: null,
      };
    }
  }

  if (isDryRun) {
    return {
      block_id: blockId,
      dry_run: true,
      pr_created: false,
      pr_number: null,
      pr_url: null,
      base_branch: blockDefinition.base_branch,
      work_branch: blockDefinition.work_branch,
      title,
      body_path: join(draftDir, 'pr-body.md'),
      draft_dir: draftDir,
      commit_shas: analysis.commits,
      blocking_issues: blockingIssues,
      safety_findings: safetyFindings,
      output_path: null,
    };
  }

  const pr = await createGitHubPr(
    owner,
    repo,
    {
      title,
      body,
      head: blockDefinition.work_branch,
      base: blockDefinition.base_branch,
      draft: true,
    },
    token,
    fetchFn
  );

  const outputData = {
    block_id: blockId,
    pr_number: pr.number,
    pr_url: pr.html_url,
    base: blockDefinition.base_branch,
    head: blockDefinition.work_branch,
    title,
    commit_shas: analysis.commits,
    created_at: new Date().toISOString(),
    no_merge_performed: true,
    no_push_performed: true,
    no_checkout_performed: true,
    no_main_touch_performed: true,
  };

  writeFileSync(prCreatedPath, JSON.stringify(outputData, null, 2), 'utf-8');

  return {
    block_id: blockId,
    dry_run: false,
    pr_created: true,
    pr_number: pr.number,
    pr_url: pr.html_url,
    base_branch: blockDefinition.base_branch,
    work_branch: blockDefinition.work_branch,
    title,
    body_path: join(draftDir, 'pr-body.md'),
    draft_dir: draftDir,
    commit_shas: analysis.commits,
    blocking_issues: blockingIssues,
    safety_findings: safetyFindings,
    output_path: prCreatedPath,
  };
}

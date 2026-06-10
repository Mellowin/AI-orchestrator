import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve, normalize } from 'node:path';
import { tmpdir } from 'node:os';
import type { BlockDefinition } from './block-types.js';
import { loadBlockState, getBlockRunDir } from './block-state-manager.js';
import { loadBlockDefinition } from './block-loader.js';
import { isPathInside } from './block-approval-report.js';

export interface BlockPrCleanupResult {
  block_id: string;
  pr_number: number;
  pr_url: string;
  base_branch: string;
  head_branch: string;
  expected_base_branch: string;
  expected_head_branch: string;
  state_before: string;
  draft_before: boolean;
  merged_before: boolean;
  close_pr_requested: boolean;
  delete_branch_requested: boolean;
  dry_run: boolean;
  pr_closed: boolean;
  branch_deleted: boolean;
  cleanup_safe: boolean;
  blocking_issues: string[];
  safety_findings: string[];
  output_path: string;
}

export interface CleanupBlockProofPrInput {
  blockDefinitionPath: string;
  prNumber?: number;
  closePr?: boolean;
  deleteBranch?: boolean;
  dryRun?: boolean;
  fetchFn?: typeof fetch;
  outputPath?: string;
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

interface PrCreatedJson {
  block_id?: string;
  pr_number?: number;
  pr_url?: string;
  base?: string;
  head?: string;
}

function readPrCreatedJson(blockId: string): PrCreatedJson | null {
  const runDir = getBlockRunDir(blockId);
  const path = join(runDir, 'pr-created.json');
  if (!existsSync(path)) {
    return null;
  }
  const content = readFileSync(path, 'utf-8');
  try {
    return JSON.parse(content) as PrCreatedJson;
  } catch {
    throw new Error('pr-created.json is malformed');
  }
}

function validatePrCreatedJson(data: PrCreatedJson | null): { prNumber: number; base: string; head: string } {
  if (!data) {
    throw new Error('pr-created.json not found for this block');
  }
  if (typeof data.pr_number !== 'number') {
    throw new Error('pr-created.json missing or invalid pr_number');
  }
  if (typeof data.base !== 'string') {
    throw new Error('pr-created.json missing or invalid base');
  }
  if (typeof data.head !== 'string') {
    throw new Error('pr-created.json missing or invalid head');
  }
  return { prNumber: data.pr_number, base: data.base, head: data.head };
}

function isProofLikeBranch(branch: string): boolean {
  return branch.startsWith('stage-') || branch.includes('proof');
}

async function fetchGitHubPr(
  owner: string,
  repo: string,
  prNumber: number,
  token: string | undefined,
  fetchFn: typeof fetch
): Promise<{
  state: string;
  draft: boolean;
  merged: boolean;
  base: { ref: string };
  head: { ref: string };
  html_url: string;
}> {
  const mockResponse = process.env.MOCK_GITHUB_PR_CLEANUP_RESPONSE?.trim();
  if (mockResponse) {
    const data = JSON.parse(mockResponse) as Record<string, unknown>;
    const state = typeof data.state === 'string' ? data.state : 'open';
    const draft = typeof data.draft === 'boolean' ? data.draft : true;
    const merged = typeof data.merged === 'boolean' ? data.merged : false;
    const html_url = typeof data.html_url === 'string' ? data.html_url : `https://github.com/${owner}/${repo}/pulls/${prNumber}`;
    const baseRef =
      data.base && typeof (data.base as Record<string, unknown>).ref === 'string'
        ? String((data.base as Record<string, unknown>).ref)
        : '';
    const headRef =
      data.head && typeof (data.head as Record<string, unknown>).ref === 'string'
        ? String((data.head as Record<string, unknown>).ref)
        : '';
    return { state, draft, merged, base: { ref: baseRef }, head: { ref: headRef }, html_url };
  }

  const url = `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}`;
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  const response = await fetchFn(url, { method: 'GET', headers });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`GitHub API error ${response.status}: ${text.slice(0, 200)}`);
  }
  const data = (await response.json()) as Record<string, unknown>;

  const state = typeof data.state === 'string' ? data.state : 'unknown';
  const draft = typeof data.draft === 'boolean' ? data.draft : false;
  const merged = typeof data.merged === 'boolean' ? data.merged : false;
  const html_url = typeof data.html_url === 'string' ? data.html_url : '';

  const baseRef =
    data.base && typeof (data.base as Record<string, unknown>).ref === 'string'
      ? String((data.base as Record<string, unknown>).ref)
      : '';
  const headRef =
    data.head && typeof (data.head as Record<string, unknown>).ref === 'string'
      ? String((data.head as Record<string, unknown>).ref)
      : '';

  if (!html_url) {
    throw new Error('GitHub API response missing PR html_url');
  }

  return { state, draft, merged, base: { ref: baseRef }, head: { ref: headRef }, html_url };
}

async function closeGitHubPr(
  owner: string,
  repo: string,
  prNumber: number,
  token: string,
  fetchFn: typeof fetch
): Promise<void> {
  const mockClose = process.env.MOCK_GITHUB_PR_CLEANUP_CLOSE_RESPONSE?.trim();
  if (mockClose) {
    const data = JSON.parse(mockClose) as Record<string, unknown>;
    if (data.ok === false) {
      throw new Error(`GitHub API close error ${data.status}: ${String(data.text ?? '').slice(0, 200)}`);
    }
    return;
  }

  const url = `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}`;
  const response = await fetchFn(url, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ state: 'closed' }),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`GitHub API close error ${response.status}: ${text.slice(0, 200)}`);
  }
}

async function deleteGitHubBranch(
  owner: string,
  repo: string,
  branch: string,
  token: string,
  fetchFn: typeof fetch
): Promise<void> {
  const mockDelete = process.env.MOCK_GITHUB_PR_CLEANUP_DELETE_RESPONSE?.trim();
  if (mockDelete) {
    const data = JSON.parse(mockDelete) as Record<string, unknown>;
    if (data.ok === false) {
      throw new Error(`GitHub API delete error ${data.status}: ${String(data.text ?? '').slice(0, 200)}`);
    }
    return;
  }

  const url = `https://api.github.com/repos/${owner}/${repo}/git/refs/heads/${encodeURIComponent(branch)}`;
  const response = await fetchFn(url, {
    method: 'DELETE',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`GitHub API delete error ${response.status}: ${text.slice(0, 200)}`);
  }
}

function generateCleanupReport(result: BlockPrCleanupResult, blockDefinition: BlockDefinition): string {
  const lines: string[] = [];
  lines.push('# PR Cleanup Report');
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  lines.push(`- **Block ID:** ${result.block_id}`);
  lines.push(`- **PR number:** ${result.pr_number}`);
  lines.push(`- **PR URL:** ${result.pr_url}`);
  lines.push(`- **Base branch:** ${result.base_branch}`);
  lines.push(`- **Head branch:** ${result.head_branch}`);
  lines.push(`- **State before:** ${result.state_before}`);
  lines.push(`- **Draft before:** ${result.draft_before ? 'yes' : 'no'}`);
  lines.push(`- **Merged before:** ${result.merged_before ? 'yes' : 'no'}`);
  lines.push(`- **Dry run:** ${result.dry_run ? 'yes' : 'no'}`);
  lines.push(`- **Close PR requested:** ${result.close_pr_requested ? 'yes' : 'no'}`);
  lines.push(`- **Delete branch requested:** ${result.delete_branch_requested ? 'yes' : 'no'}`);
  lines.push(`- **PR closed:** ${result.pr_closed ? 'yes' : 'no'}`);
  lines.push(`- **Branch deleted:** ${result.branch_deleted ? 'yes' : 'no'}`);
  lines.push(`- **Cleanup safe:** ${result.cleanup_safe ? 'yes' : 'no'}`);
  lines.push('');
  lines.push('## Safety verification');
  lines.push('');
  lines.push(`- **Expected base:** ${result.expected_base_branch}`);
  lines.push(`- **Actual base:** ${result.base_branch}`);
  lines.push(`- **Expected head:** ${result.expected_head_branch}`);
  lines.push(`- **Actual head:** ${result.head_branch}`);
  lines.push(`- **Proof-like branch:** ${isProofLikeBranch(result.head_branch) ? 'yes' : 'no'}`);
  lines.push(`- **Merged check:** ${result.merged_before ? 'FAIL' : 'PASS'}`);
  lines.push(`- **Base match:** ${result.base_branch === result.expected_base_branch ? 'PASS' : 'FAIL'}`);
  lines.push(`- **Head match:** ${result.head_branch === result.expected_head_branch ? 'PASS' : 'FAIL'}`);
  lines.push(`- **Head is not main:** ${result.head_branch !== 'main' ? 'PASS' : 'FAIL'}`);
  lines.push(`- **Branch delete requires PR closed or same-command close:** ${
    result.delete_branch_requested && result.state_before === 'open' && !result.close_pr_requested ? 'FAIL' : 'PASS'
  }`);
  lines.push('');
  lines.push('## Blocking issues');
  lines.push('');
  if (result.blocking_issues.length > 0) {
    for (const issue of result.blocking_issues) {
      lines.push(`- ${issue}`);
    }
  } else {
    lines.push('- none');
  }
  lines.push('');
  lines.push('## Safety findings');
  lines.push('');
  if (result.safety_findings.length > 0) {
    for (const finding of result.safety_findings) {
      lines.push(`- ${finding}`);
    }
  } else {
    lines.push('- none');
  }
  lines.push('');
  lines.push('## What this command did NOT do');
  lines.push('');
  lines.push('- No merge');
  lines.push('- No auto-merge');
  lines.push('- No push');
  lines.push('- No checkout/switch');
  lines.push('- No main touch');
  lines.push('- No provider call');
  lines.push('- No token persisted');
  lines.push('');
  return lines.join('\n');
}

export async function cleanupBlockProofPr(input: CleanupBlockProofPrInput): Promise<BlockPrCleanupResult> {
  const allowCleanup = getEnv('ALLOW_BLOCK_PR_CLEANUP') === 'true';
  const repository = getEnv('GITHUB_REPOSITORY');
  const token = getEnv('GITHUB_TOKEN');
  const fetchFn = input.fetchFn ?? globalThis.fetch;

  const envDryRun = getEnv('BLOCK_PR_CLEANUP_DRY_RUN');
  let isDryRun = true;
  if (input.dryRun === false && envDryRun !== 'true') {
    isDryRun = false;
  }
  if (envDryRun === 'true') {
    isDryRun = true;
  }

  if (!allowCleanup) {
    throw new Error('ALLOW_BLOCK_PR_CLEANUP=true is required');
  }
  if (!repository) {
    throw new Error('GITHUB_REPOSITORY is required');
  }

  const { owner, repo } = validateRepositoryFormat(repository);

  const blockDefinition = loadBlockDefinition(input.blockDefinitionPath);
  const blockId = blockDefinition.block_id;

  const blockState = loadBlockState(blockId);
  if (!blockState) {
    throw new Error(`Block state not found: ${blockId}`);
  }

  const prCreated = readPrCreatedJson(blockId);
  let prNumber: number;
  let expectedBase: string;
  let expectedHead: string;

  if (input.prNumber !== undefined) {
    prNumber = input.prNumber;
    expectedBase = blockDefinition.base_branch;
    expectedHead = blockDefinition.work_branch;
  } else {
    const validated = validatePrCreatedJson(prCreated);
    prNumber = validated.prNumber;
    expectedBase = validated.base;
    expectedHead = validated.head;
  }

  if (!prNumber || prNumber <= 0) {
    throw new Error('PR number is missing or invalid');
  }

  const prData = await fetchGitHubPr(owner, repo, prNumber, token, fetchFn);

  const closePrRequested = input.closePr === true;
  const deleteBranchRequested = input.deleteBranch === true;

  const blockingIssues: string[] = [];
  const safetyFindings: string[] = [];

  if (prData.merged) {
    blockingIssues.push('PR is already merged');
  }
  if (prData.state === 'closed' && !prData.merged) {
    // Already closed is not a blocker for cleanup, but note it
    safetyFindings.push('PR is already closed');
  }
  if (prData.base.ref !== expectedBase) {
    blockingIssues.push(`PR base branch mismatch: expected ${expectedBase}, got ${prData.base.ref}`);
  }
  if (prData.head.ref !== expectedHead) {
    blockingIssues.push(`PR head branch mismatch: expected ${expectedHead}, got ${prData.head.ref}`);
  }
  if (prData.base.ref === 'main' && expectedBase !== 'main') {
    blockingIssues.push('PR base is main unexpectedly');
  }
  if (prData.head.ref === 'main') {
    blockingIssues.push('PR head is main');
  }
  if (!isProofLikeBranch(prData.head.ref)) {
    blockingIssues.push(`Head branch does not look like a proof branch: ${prData.head.ref}`);
  }
  if (deleteBranchRequested && prData.state === 'open' && !closePrRequested) {
    blockingIssues.push('Cannot delete proof branch while PR is still open unless closePr is requested in the same cleanup command');
  }

  if (closePrRequested && !isDryRun) {
    const allowClose = getEnv('ALLOW_GITHUB_PR_CLOSE') === 'true';
    if (!allowClose) {
      blockingIssues.push('ALLOW_GITHUB_PR_CLOSE=true is required to close PR');
    } else if (!token) {
      blockingIssues.push('GITHUB_TOKEN is required to close PR');
    }
  }

  if (deleteBranchRequested && !isDryRun) {
    const allowDelete = getEnv('ALLOW_GITHUB_BRANCH_DELETE') === 'true';
    if (!allowDelete) {
      blockingIssues.push('ALLOW_GITHUB_BRANCH_DELETE=true is required to delete branch');
    } else if (!token) {
      blockingIssues.push('GITHUB_TOKEN is required to delete branch');
    }
  }

  const cleanupSafe = blockingIssues.length === 0;

  let prClosed = false;
  let branchDeleted = false;

  if (!isDryRun && cleanupSafe) {
    if (closePrRequested && prData.state !== 'closed') {
      try {
        await closeGitHubPr(owner, repo, prNumber, token!, fetchFn);
        prClosed = true;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        blockingIssues.push(`Failed to close PR: ${message}`);
        safetyFindings.push('PR close failed; branch deletion was skipped');
      }
    } else if (closePrRequested && prData.state === 'closed') {
      prClosed = true;
      safetyFindings.push('PR was already closed');
    }

    // Only delete branch if PR is/was closed and no new blocking issues from close attempt
    if (deleteBranchRequested && blockingIssues.length === 0) {
      try {
        await deleteGitHubBranch(owner, repo, prData.head.ref, token!, fetchFn);
        branchDeleted = true;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        blockingIssues.push(`Failed to delete branch: ${message}`);
      }
    }
  }

  if (isDryRun) {
    if (closePrRequested) {
      safetyFindings.push('Dry run: PR close was not performed');
    }
    if (deleteBranchRequested) {
      safetyFindings.push('Dry run: branch delete was not performed');
    }
  }

  const result: BlockPrCleanupResult = {
    block_id: blockId,
    pr_number: prNumber,
    pr_url: prData.html_url,
    base_branch: prData.base.ref,
    head_branch: prData.head.ref,
    expected_base_branch: expectedBase,
    expected_head_branch: expectedHead,
    state_before: prData.state,
    draft_before: prData.draft,
    merged_before: prData.merged,
    close_pr_requested: closePrRequested,
    delete_branch_requested: deleteBranchRequested,
    dry_run: isDryRun,
    pr_closed: prClosed,
    branch_deleted: branchDeleted,
    cleanup_safe: blockingIssues.length === 0,
    blocking_issues: blockingIssues,
    safety_findings: safetyFindings,
    output_path: '',
  };

  // Resolve output path
  const runDir = getBlockRunDir(blockId);
  let outputPath = input.outputPath ?? join(runDir, 'pr-cleanup-report.md');
  const resolvedOutputPath = resolve(normalize(outputPath));
  const cwdResolved = resolve(normalize(process.cwd()));
  const runsDirResolved = resolve(normalize(join(process.cwd(), 'runs')));
  const tmpDirResolved = resolve(normalize(tmpdir()));
  const allowedBases = [runsDirResolved, cwdResolved, tmpDirResolved];
  const isAllowed = allowedBases.some(
    (base) => isPathInside(base, resolvedOutputPath) || resolve(base) === resolve(resolvedOutputPath)
  );
  if (!isAllowed) {
    throw new Error('Output path is outside allowed directory');
  }

  const report = generateCleanupReport(result, blockDefinition);
  writeFileSync(outputPath, report, 'utf-8');
  result.output_path = outputPath;

  return result;
}

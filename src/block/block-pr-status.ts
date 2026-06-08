import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve, normalize } from 'node:path';
import { tmpdir } from 'node:os';
import type { BlockDefinition, BlockState } from './block-types.js';
import { loadBlockState, getBlockRunDir } from './block-state-manager.js';
import { loadBlockDefinition } from './block-loader.js';
import { isPathInside } from './block-approval-report.js';

export interface BlockPrStatusResult {
  block_id: string;
  pr_number: number;
  pr_url: string;
  state: string;
  draft: boolean;
  merged: boolean;
  base_branch: string;
  head_branch: string;
  base_matches_block: boolean;
  head_matches_block: boolean;
  commits_count: number;
  changed_files_count: number;
  checks_status: 'success' | 'failure' | 'pending' | 'unknown';
  pr_safe_for_human_review: boolean;
  blocking_issues: string[];
  safety_findings: string[];
  output_path: string;
}

export interface GetBlockPrStatusInput {
  blockDefinitionPath: string;
  prNumber?: number;
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
  title?: string;
  commit_shas?: string[];
  created_at?: string;
  no_merge_performed?: boolean;
  no_push_performed?: boolean;
  no_checkout_performed?: boolean;
  no_main_touch_performed?: boolean;
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
  commits: number;
  changed_files: number;
}> {
  const mockResponse = process.env.MOCK_GITHUB_PR_STATUS_RESPONSE?.trim();
  if (mockResponse) {
    const data = JSON.parse(mockResponse) as Record<string, unknown>;
    const state = typeof data.state === 'string' ? data.state : 'open';
    const draft = typeof data.draft === 'boolean' ? data.draft : true;
    const merged = typeof data.merged === 'boolean' ? data.merged : false;
    const html_url = typeof data.html_url === 'string' ? data.html_url : `https://github.com/${owner}/${repo}/pulls/${prNumber}`;
    const commits = typeof data.commits === 'number' ? data.commits : 0;
    const changed_files = typeof data.changed_files === 'number' ? data.changed_files : 0;
    const baseRef =
      data.base && typeof (data.base as Record<string, unknown>).ref === 'string'
        ? String((data.base as Record<string, unknown>).ref)
        : '';
    const headRef =
      data.head && typeof (data.head as Record<string, unknown>).ref === 'string'
        ? String((data.head as Record<string, unknown>).ref)
        : '';
    return { state, draft, merged, base: { ref: baseRef }, head: { ref: headRef }, html_url, commits, changed_files };
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
  const commits = typeof data.commits === 'number' ? data.commits : 0;
  const changed_files = typeof data.changed_files === 'number' ? data.changed_files : 0;

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

  return {
    state,
    draft,
    merged,
    base: { ref: baseRef },
    head: { ref: headRef },
    html_url,
    commits,
    changed_files,
  };
}

async function fetchCheckRuns(
  owner: string,
  repo: string,
  headRef: string,
  token: string | undefined,
  fetchFn: typeof fetch
): Promise<{ status: 'success' | 'failure' | 'pending' | 'unknown'; finding?: string }> {
  const mockChecks = process.env.MOCK_GITHUB_PR_STATUS_CHECKS_RESPONSE?.trim();
  if (mockChecks) {
    const data = JSON.parse(mockChecks) as Record<string, unknown>;
    const checkRuns = Array.isArray(data.check_runs) ? data.check_runs : [];
    if (checkRuns.length === 0) {
      return { status: 'unknown', finding: 'CI/checks were not verified by this report' };
    }
    const conclusions = checkRuns.map(
      (c: unknown) =>
        typeof c === 'object' && c !== null
          ? (c as Record<string, unknown>).conclusion
          : undefined
    );
    const statuses = checkRuns.map(
      (c: unknown) =>
        typeof c === 'object' && c !== null
          ? (c as Record<string, unknown>).status
          : undefined
    );
    if (conclusions.some((c) => c === 'failure')) {
      return { status: 'failure' };
    }
    if (statuses.some((s) => s !== 'completed')) {
      return { status: 'pending' };
    }
    if (conclusions.every((c) => c === 'success')) {
      return { status: 'success' };
    }
    return { status: 'unknown', finding: 'CI/checks were not verified by this report' };
  }

  const url = `https://api.github.com/repos/${owner}/${repo}/commits/${encodeURIComponent(headRef)}/check-runs`;
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  try {
    const response = await fetchFn(url, { method: 'GET', headers });
    if (!response.ok) {
      return { status: 'unknown', finding: 'CI/checks were not verified by this report' };
    }
    const data = (await response.json()) as Record<string, unknown>;
    const checkRuns = Array.isArray(data.check_runs) ? data.check_runs : [];
    if (checkRuns.length === 0) {
      return { status: 'unknown', finding: 'CI/checks were not verified by this report' };
    }

    const conclusions = checkRuns.map(
      (c: unknown) =>
        typeof c === 'object' && c !== null
          ? (c as Record<string, unknown>).conclusion
          : undefined
    );
    const statuses = checkRuns.map(
      (c: unknown) =>
        typeof c === 'object' && c !== null
          ? (c as Record<string, unknown>).status
          : undefined
    );

    if (conclusions.some((c) => c === 'failure')) {
      return { status: 'failure' };
    }
    if (statuses.some((s) => s !== 'completed')) {
      return { status: 'pending' };
    }
    if (conclusions.every((c) => c === 'success')) {
      return { status: 'success' };
    }
    return { status: 'unknown', finding: 'CI/checks were not verified by this report' };
  } catch {
    return { status: 'unknown', finding: 'CI/checks were not verified by this report' };
  }
}

function generatePrStatusReport(result: BlockPrStatusResult, blockDefinition: BlockDefinition): string {
  const lines: string[] = [];
  lines.push('# PR Status Report');
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  lines.push(`- **Block ID:** ${result.block_id}`);
  lines.push(`- **PR number:** ${result.pr_number}`);
  lines.push(`- **PR URL:** ${result.pr_url}`);
  lines.push(`- **State:** ${result.state}`);
  lines.push(`- **Draft:** ${result.draft ? 'yes' : 'no'}`);
  lines.push(`- **Merged:** ${result.merged ? 'yes' : 'no'}`);
  lines.push(`- **Base branch:** ${result.base_branch}`);
  lines.push(`- **Head branch:** ${result.head_branch}`);
  lines.push(`- **Commits count:** ${result.commits_count}`);
  lines.push(`- **Changed files count:** ${result.changed_files_count}`);
  lines.push(`- **Checks status:** ${result.checks_status}`);
  lines.push(`- **Safe for human review:** ${result.pr_safe_for_human_review ? 'yes' : 'no'}`);
  lines.push('');
  lines.push('## Branch verification');
  lines.push('');
  lines.push(`- **Expected base:** ${blockDefinition.base_branch}`);
  lines.push(`- **Actual base:** ${result.base_branch}`);
  lines.push(`- **Expected head:** ${blockDefinition.work_branch}`);
  lines.push(`- **Actual head:** ${result.head_branch}`);
  lines.push(`- **Base matches:** ${result.base_matches_block ? 'yes' : 'no'}`);
  lines.push(`- **Head matches:** ${result.head_matches_block ? 'yes' : 'no'}`);
  lines.push('');
  lines.push('## Safety findings');
  lines.push('');
  if (result.blocking_issues.length > 0) {
    for (const issue of result.blocking_issues) {
      lines.push(`- ${issue}`);
    }
  } else if (result.safety_findings.length > 0) {
    for (const finding of result.safety_findings) {
      lines.push(`- ${finding}`);
    }
    lines.push('');
    lines.push('No blocking PR safety findings detected. Human review is still required.');
  } else {
    lines.push('No blocking PR safety findings detected. Human review is still required.');
  }
  lines.push('');
  lines.push('## What this command did NOT do');
  lines.push('');
  lines.push('- No PR creation');
  lines.push('- No PR update');
  lines.push('- No PR close');
  lines.push('- No PR merge');
  lines.push('- No comment');
  lines.push('- No review approval');
  lines.push('- No push');
  lines.push('- No checkout/switch');
  lines.push('- No main touch');
  lines.push('- No provider call');
  lines.push('');
  return lines.join('\n');
}

export async function getBlockPrStatus(input: GetBlockPrStatusInput): Promise<BlockPrStatusResult> {
  const allowStatus = getEnv('ALLOW_GITHUB_PR_STATUS') === 'true';
  const repository = getEnv('GITHUB_REPOSITORY');
  const token = getEnv('GITHUB_TOKEN');
  const fetchFn = input.fetchFn ?? globalThis.fetch;

  if (!allowStatus) {
    throw new Error('ALLOW_GITHUB_PR_STATUS=true is required');
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

  const checks = await fetchCheckRuns(owner, repo, prData.head.ref, token, fetchFn);

  const blockingIssues: string[] = [];
  const safetyFindings: string[] = [];

  if (prData.merged) {
    blockingIssues.push('PR is already merged');
  }
  if (prData.state === 'closed' && !prData.merged) {
    blockingIssues.push('PR is closed');
  }
  if (!prData.draft) {
    blockingIssues.push('PR is not draft');
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
  if (checks.status === 'failure') {
    blockingIssues.push('Checks status is failure');
  }
  if (checks.finding) {
    safetyFindings.push(checks.finding);
  }

  const baseMatchesBlock = prData.base.ref === blockDefinition.base_branch;
  const headMatchesBlock = prData.head.ref === blockDefinition.work_branch;

  const result: BlockPrStatusResult = {
    block_id: blockId,
    pr_number: prNumber,
    pr_url: prData.html_url,
    state: prData.state,
    draft: prData.draft,
    merged: prData.merged,
    base_branch: prData.base.ref,
    head_branch: prData.head.ref,
    base_matches_block: baseMatchesBlock,
    head_matches_block: headMatchesBlock,
    commits_count: prData.commits,
    changed_files_count: prData.changed_files,
    checks_status: checks.status,
    pr_safe_for_human_review: blockingIssues.length === 0,
    blocking_issues: blockingIssues,
    safety_findings: safetyFindings,
    output_path: '',
  };

  // Resolve output path
  const runDir = getBlockRunDir(blockId);
  let outputPath = input.outputPath ?? join(runDir, 'pr-status-report.md');
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

  const report = generatePrStatusReport(result, blockDefinition);
  writeFileSync(outputPath, report, 'utf-8');
  result.output_path = outputPath;

  return result;
}

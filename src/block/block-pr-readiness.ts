import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve, normalize } from 'node:path';
import { tmpdir } from 'node:os';
import { loadBlockDefinition } from './block-loader.js';
import { isPathInside } from './block-approval-report.js';
import { getBlockRunDir } from './block-state-manager.js';
import { redactReviewerText } from '../reviewer/reviewer-redaction.js';

export interface BlockPrReadinessInput {
  blockDefinitionPath: string;
  prNumber?: number;
  fetchFn?: typeof fetch;
  outputPath?: string;
}

export interface BlockPrReadinessResult {
  block_id: string;
  pr_number: number;
  pr_url: string;
  state: string;
  draft: boolean;
  merged: boolean;
  base_branch: string;
  head_branch: string;
  head_sha: string;
  checks_status: 'success' | 'failure' | 'pending' | 'unknown';
  readiness: 'ready' | 'not_ready';
  dry_run: boolean;
  would_mark_ready: boolean;
  marked_ready: boolean;
  blocking_issues: string[];
  safety_findings: string[];
  output_path: string;
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
  head: { ref: string; sha: string };
  html_url: string;
  commits: number;
  changed_files: number;
  node_id: string;
}> {
  const mockResponse = process.env.MOCK_GITHUB_PR_READINESS_RESPONSE?.trim();
  if (mockResponse) {
    const data = JSON.parse(mockResponse) as Record<string, unknown>;
    const state = typeof data.state === 'string' ? data.state : 'open';
    const draft = typeof data.draft === 'boolean' ? data.draft : true;
    const merged = typeof data.merged === 'boolean' ? data.merged : false;
    const html_url =
      typeof data.html_url === 'string'
        ? data.html_url
        : `https://github.com/${owner}/${repo}/pulls/${prNumber}`;
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
    const headSha =
      data.head && typeof (data.head as Record<string, unknown>).sha === 'string'
        ? String((data.head as Record<string, unknown>).sha)
        : '';
    const nodeId = typeof data.node_id === 'string' ? data.node_id : '';
    return {
      state,
      draft,
      merged,
      base: { ref: baseRef },
      head: { ref: headRef, sha: headSha },
      html_url,
      commits,
      changed_files,
      node_id: nodeId,
    };
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
  const headSha =
    data.head && typeof (data.head as Record<string, unknown>).sha === 'string'
      ? String((data.head as Record<string, unknown>).sha)
      : '';
  const nodeId = typeof data.node_id === 'string' ? data.node_id : '';

  if (!html_url) {
    throw new Error('GitHub API response missing PR html_url');
  }

  return {
    state,
    draft,
    merged,
    base: { ref: baseRef },
    head: { ref: headRef, sha: headSha },
    html_url,
    commits,
    changed_files,
    node_id: nodeId,
  };
}

async function fetchCheckRuns(
  owner: string,
  repo: string,
  headRef: string,
  token: string | undefined,
  fetchFn: typeof fetch
): Promise<{ status: 'success' | 'failure' | 'pending' | 'unknown'; finding?: string }> {
  const mockChecks = process.env.MOCK_GITHUB_PR_READINESS_CHECKS_RESPONSE?.trim();
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

async function markPrReady(
  nodeId: string,
  token: string,
  fetchFn: typeof fetch
): Promise<{ ok: boolean }> {
  const mockMark = process.env.MOCK_GITHUB_PR_READINESS_MARK_RESPONSE?.trim();
  if (mockMark) {
    const data = JSON.parse(mockMark) as Record<string, unknown>;
    return { ok: typeof data.ok === 'boolean' ? data.ok : false };
  }

  const url = 'https://api.github.com/graphql';
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
  };
  const body = JSON.stringify({
    query:
      'mutation($pullRequestId: ID!) { markPullRequestReadyForReview(input: { pullRequestId: $pullRequestId }) { pullRequest { number isDraft merged state url } } }',
    variables: { pullRequestId: nodeId },
  });
  const response = await fetchFn(url, { method: 'POST', headers, body });
  if (!response.ok) {
    return { ok: false };
  }
  try {
    const data = (await response.json()) as Record<string, unknown>;
    if (Array.isArray(data.errors) && data.errors.length > 0) {
      return { ok: false };
    }
    return { ok: true };
  } catch {
    return { ok: false };
  }
}

function generatePrReadinessReport(result: BlockPrReadinessResult): string {
  const lines: string[] = [];
  lines.push('# PR Readiness Report');
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
  lines.push(`- **Head SHA:** ${result.head_sha}`);
  lines.push(`- **Checks status:** ${result.checks_status}`);
  lines.push(`- **Readiness:** ${result.readiness}`);
  lines.push(`- **Dry run:** ${result.dry_run ? 'yes' : 'no'}`);
  lines.push(`- **Would mark ready:** ${result.would_mark_ready ? 'yes' : 'no'}`);
  lines.push(`- **Marked ready:** ${result.marked_ready ? 'yes' : 'no'}`);
  lines.push('');
  lines.push('## Blocking Issues');
  lines.push('');
  if (result.blocking_issues.length > 0) {
    for (const issue of result.blocking_issues) {
      lines.push(`- ${issue}`);
    }
  } else {
    lines.push('No blocking issues.');
  }
  lines.push('');
  lines.push('## Safety Findings');
  lines.push('');
  if (result.safety_findings.length > 0) {
    for (const finding of result.safety_findings) {
      lines.push(`- ${finding}`);
    }
  } else {
    lines.push('No safety findings.');
  }
  lines.push('');
  lines.push('## What this command did NOT do');
  lines.push('');
  lines.push('- No merge was performed.');
  lines.push('- No auto-merge was performed.');
  lines.push('- No main branch touch occurred.');
  lines.push('- No checkout or branch switch occurred.');
  lines.push('- No force push was performed.');
  lines.push('- No provider call was made.');
  lines.push('- No PR comment, review, close, or update occurred (except the optional draft→ready GraphQL mutation).');
  lines.push('');
  return lines.join('\n');
}

export async function checkBlockPrReadiness(input: BlockPrReadinessInput): Promise<BlockPrReadinessResult> {
  const allow = getEnv('ALLOW_BLOCK_PR_READINESS') === 'true';
  if (!allow) {
    throw new Error('ALLOW_BLOCK_PR_READINESS=true is required');
  }

  const repository = getEnv('GITHUB_REPOSITORY');
  if (!repository) {
    throw new Error('GITHUB_REPOSITORY is required');
  }
  const { owner, repo } = validateRepositoryFormat(repository);

  let prNumber: number;
  if (input.prNumber !== undefined) {
    prNumber = input.prNumber;
  } else {
    const blockPrNumber = getEnv('BLOCK_PR_NUMBER');
    if (!blockPrNumber) {
      throw new Error('BLOCK_PR_NUMBER is required');
    }
    const parsed = parseInt(blockPrNumber, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      throw new Error('BLOCK_PR_NUMBER must be a positive integer');
    }
    prNumber = parsed;
  }

  if (!prNumber || prNumber <= 0) {
    throw new Error('PR number is missing or invalid');
  }

  const isDryRun = getEnv('BLOCK_PR_READINESS_DRY_RUN') !== 'false';
  const requireCi = getEnv('BLOCK_PR_READINESS_REQUIRE_CI') !== 'false';
  const token = getEnv('GITHUB_TOKEN');
  const fetchFn = input.fetchFn ?? globalThis.fetch;

  const blockDefinition = loadBlockDefinition(input.blockDefinitionPath);
  const blockId = blockDefinition.block_id;

  const prData = await fetchGitHubPr(owner, repo, prNumber, token, fetchFn);
  const checks = await fetchCheckRuns(owner, repo, prData.head.ref, token, fetchFn);

  const isMockPr = !!process.env.MOCK_GITHUB_PR_READINESS_RESPONSE?.trim();
  const isMockChecks = !!process.env.MOCK_GITHUB_PR_READINESS_CHECKS_RESPONSE?.trim();

  const blockingIssues: string[] = [];
  const safetyFindings: string[] = [];

  if (isMockPr) {
    safetyFindings.push('PR readiness PR data came from mock response; real GitHub API was not verified by this run');
  }
  if (isMockChecks) {
    safetyFindings.push('PR readiness check runs came from mock response; real GitHub API was not verified by this run');
  }

  if (prData.state !== 'open') {
    blockingIssues.push('PR is not open');
  }
  if (prData.merged) {
    blockingIssues.push('PR is already merged');
  }
  if (prData.draft === false) {
    blockingIssues.push('PR is not draft');
  }
  if (prData.head.ref === 'main' || prData.head.ref === 'master') {
    blockingIssues.push('PR head is main/master');
  }
  if (prData.base.ref !== blockDefinition.base_branch) {
    blockingIssues.push('PR base branch mismatch');
  }
  if (checks.status === 'failure') {
    blockingIssues.push('CI/checks failed');
  }
  if (checks.status === 'pending' && requireCi) {
    blockingIssues.push('CI/checks pending');
  }
  if (checks.status === 'unknown' && requireCi) {
    blockingIssues.push('CI/checks status unknown');
  }
  if (checks.finding) {
    safetyFindings.push(checks.finding);
  }

  let readiness: 'ready' | 'not_ready' = blockingIssues.length === 0 ? 'ready' : 'not_ready';
  const wouldMarkReady = readiness === 'ready' && !isDryRun && getEnv('ALLOW_GITHUB_MARK_READY') === 'true' && !!token;
  let markedReady = false;

  if (wouldMarkReady) {
    if (!token) {
      // This should not happen because wouldMarkReady requires !!token,
      // but we keep the guard for type safety.
      blockingIssues.push('Failed to mark PR ready for review');
      readiness = 'not_ready';
    } else if (!prData.node_id) {
      blockingIssues.push('GitHub PR node_id missing; cannot mark ready safely');
      readiness = 'not_ready';
    } else {
      const patchResult = await markPrReady(prData.node_id, token, fetchFn);
      if (patchResult.ok) {
        markedReady = true;
      } else {
        blockingIssues.push('Failed to mark PR ready for review');
        readiness = 'not_ready';
      }
    }
  }

  const runDir = getBlockRunDir(blockId);
  const defaultOutputPath = join(runDir, 'pr-readiness', 'report.md');
  const envOutputDir = getEnv('BLOCK_PR_READINESS_OUTPUT_DIR');
  let outputPath = input.outputPath ?? (envOutputDir ? join(envOutputDir, 'report.md') : defaultOutputPath);

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

  const reportDir = join(resolvedOutputPath, '..');
  const resolvedReportDir = resolve(normalize(reportDir));
  const isReportDirAllowed = allowedBases.some(
    (base) => isPathInside(base, resolvedReportDir) || resolve(base) === resolve(resolvedReportDir)
  );
  if (!isReportDirAllowed) {
    throw new Error('Output path parent directory is outside allowed directory');
  }
  if (!existsSync(reportDir)) {
    mkdirSync(reportDir, { recursive: true });
  }

  const result: BlockPrReadinessResult = {
    block_id: blockId,
    pr_number: prNumber,
    pr_url: prData.html_url,
    state: prData.state,
    draft: prData.draft,
    merged: prData.merged,
    base_branch: prData.base.ref,
    head_branch: prData.head.ref,
    head_sha: prData.head.sha,
    checks_status: checks.status,
    readiness,
    dry_run: isDryRun,
    would_mark_ready: wouldMarkReady,
    marked_ready: markedReady,
    blocking_issues: blockingIssues,
    safety_findings: safetyFindings,
    output_path: outputPath,
  };

  let report = generatePrReadinessReport(result);
  const redactedReport = redactReviewerText(report);
  let finalReport = redactedReport;

  if (redactedReport !== report) {
    safetyFindings.push('Possible secret was redacted from report');
    result.safety_findings = safetyFindings;
    finalReport = redactReviewerText(generatePrReadinessReport(result));
  }

  writeFileSync(outputPath, finalReport, 'utf-8');
  result.output_path = outputPath;

  return result;
}

import type { AutopilotRunConfig } from './types.js';
import type { DiagnoseCiWorkflowRun } from '../diagnose-ci/types.js';

export class AutopilotGithubError extends Error {
  constructor(
    public readonly verdict: 'AUTOPILOT_NEEDS_TOKEN' | 'AUTOPILOT_ACCESS_ERROR' | 'AUTOPILOT_FAILED',
    message: string,
    public readonly status?: number
  ) {
    super(message);
  }
}

function getToken(config: AutopilotRunConfig): string {
  const token = process.env[config.diagnose_config.token_env];
  if (token === undefined || token.trim().length === 0) {
    throw new AutopilotGithubError(
      'AUTOPILOT_NEEDS_TOKEN',
      `Missing GitHub token in ${config.diagnose_config.token_env}`
    );
  }
  return token;
}

function githubHeaders(token: string): Record<string, string> {
  return {
    Authorization: `token ${token}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'ai-orchestrator',
  };
}

async function githubJsonRequest(
  url: string,
  token: string,
  fetchFn: typeof globalThis.fetch
): Promise<Record<string, unknown>> {
  const response = await fetchFn(url, {
    headers: githubHeaders(token),
    redirect: 'follow',
  });

  if (response.status === 401 || response.status === 403) {
    throw new AutopilotGithubError(
      'AUTOPILOT_ACCESS_ERROR',
      `GitHub API access denied (${response.status})`,
      response.status
    );
  }
  if (!response.ok) {
    throw new AutopilotGithubError(
      'AUTOPILOT_FAILED',
      `GitHub API error ${response.status} for ${url}`,
      response.status
    );
  }

  return (await response.json()) as Record<string, unknown>;
}

function normalizeRun(data: Record<string, unknown>): DiagnoseCiWorkflowRun {
  return {
    id: Number(data.id),
    run_number: Number(data.run_number),
    name: String(data.name ?? ''),
    event: String(data.event ?? ''),
    branch: String(data.head_branch ?? ''),
    head_sha: String(data.head_sha ?? ''),
    status: String(data.status ?? ''),
    conclusion: data.conclusion === null || data.conclusion === undefined ? null : String(data.conclusion),
    html_url: data.html_url === undefined ? undefined : String(data.html_url),
  };
}

export async function resolveAutopilotWorkflowRunId(
  config: AutopilotRunConfig,
  headSha: string,
  fetchFn: typeof globalThis.fetch
): Promise<number> {
  if (config.mode === 'fake') {
    return 123456789;
  }

  const token = getToken(config);
  const [owner, repo] = config.repo_slug.split('/');
  const baseUrl = `https://api.github.com/repos/${owner}/${repo}`;
  const url = `${baseUrl}/actions/runs?head_sha=${encodeURIComponent(headSha)}&per_page=1`;

  const deadline = Date.now() + config.ci.timeout_seconds * 1000;
  const pollIntervalMs = config.ci.poll_interval_seconds * 1000;

  while (Date.now() < deadline) {
    const data = await githubJsonRequest(url, token, fetchFn);
    const runs = Array.isArray(data.workflow_runs) ? data.workflow_runs : [];
    if (runs.length > 0) {
      return Number((runs[0] as Record<string, unknown>).id);
    }
    await sleep(pollIntervalMs);
  }

  throw new AutopilotGithubError(
    'AUTOPILOT_FAILED',
    `No workflow runs found for head SHA ${headSha} after ${config.ci.timeout_seconds}s`
  );
}

export interface PollWorkflowRunResult {
  status: 'completed' | 'timeout';
  run?: DiagnoseCiWorkflowRun;
}

export async function pollAutopilotWorkflowRun(
  config: AutopilotRunConfig,
  runId: number,
  fetchFn: typeof globalThis.fetch
): Promise<PollWorkflowRunResult> {
  if (config.mode === 'fake') {
    return {
      status: 'completed',
      run: {
        id: runId,
        run_number: 999,
        name: 'Autopilot Fake CI',
        event: 'pull_request',
        branch: config.work_branch,
        head_sha: 'fake000000000000000000000000000000000000',
        status: 'completed',
        conclusion: 'success',
      },
    };
  }

  const token = getToken(config);
  const [owner, repo] = config.repo_slug.split('/');
  const url = `https://api.github.com/repos/${owner}/${repo}/actions/runs/${runId}`;

  const deadline = Date.now() + config.ci.timeout_seconds * 1000;
  const pollIntervalMs = config.ci.poll_interval_seconds * 1000;

  while (Date.now() < deadline) {
    const data = await githubJsonRequest(url, token, fetchFn);
    const run = normalizeRun(data);

    if (run.status === 'completed') {
      return { status: 'completed', run };
    }

    await sleep(pollIntervalMs);
  }

  return { status: 'timeout' };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

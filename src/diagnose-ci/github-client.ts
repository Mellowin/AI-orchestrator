import type {
  DiagnoseCiConfig,
  DiagnoseCiFakeScenario,
  DiagnoseCiJob,
  DiagnoseCiJobStep,
  DiagnoseCiVerdict,
  DiagnoseCiWorkflowRun,
} from './types.js';

export type FetchFn = typeof globalThis.fetch;

export interface ResolveRunIdResult {
  runId: number;
  source: 'workflow_run_id' | 'pr_number' | 'commit_sha';
}

export interface WorkflowBundle {
  run: DiagnoseCiWorkflowRun;
  jobs: DiagnoseCiJob[];
  logs: Record<string, string>;
}

export class DiagnoseCiGithubError extends Error {
  constructor(
    public readonly verdict: DiagnoseCiVerdict,
    message: string,
    public readonly status?: number
  ) {
    super(message);
  }
}

function getToken(config: DiagnoseCiConfig): string {
  const token = process.env[config.token_env];
  if (token === undefined || token.trim().length === 0) {
    throw new DiagnoseCiGithubError(
      'DIAGNOSE_CI_NEEDS_TOKEN',
      `Missing GitHub token in ${config.token_env}`
    );
  }
  return token;
}

function githubHeaders(token: string): Record<string, string> {
  return {
    Authorization: `token ${token}`,
    Accept: 'application/vnd.github+json',
  };
}

async function githubJsonRequest(
  url: string,
  token: string,
  fetchFn: FetchFn
): Promise<Record<string, unknown>> {
  const response = await fetchFn(url, {
    headers: githubHeaders(token),
    redirect: 'follow',
  });

  if (response.status === 401 || response.status === 403) {
    throw new DiagnoseCiGithubError(
      'DIAGNOSE_CI_ACCESS_ERROR',
      `GitHub API access denied (${response.status})`,
      response.status
    );
  }
  if (response.status === 404) {
    throw new DiagnoseCiGithubError(
      'DIAGNOSE_CI_NOT_FOUND',
      `GitHub API returned 404 for ${url}`,
      response.status
    );
  }
  if (!response.ok) {
    throw new Error(`GitHub API error ${response.status} for ${url}`);
  }

  const data = (await response.json()) as Record<string, unknown>;
  return data;
}

async function githubTextRequest(
  url: string,
  token: string,
  fetchFn: FetchFn
): Promise<string> {
  const response = await fetchFn(url, {
    headers: githubHeaders(token),
    redirect: 'follow',
  });

  if (response.status === 401 || response.status === 403) {
    throw new DiagnoseCiGithubError(
      'DIAGNOSE_CI_ACCESS_ERROR',
      `GitHub API access denied (${response.status})`,
      response.status
    );
  }
  if (response.status === 404) {
    throw new DiagnoseCiGithubError(
      'DIAGNOSE_CI_NOT_FOUND',
      `GitHub API returned 404 for ${url}`,
      response.status
    );
  }
  if (!response.ok) {
    throw new Error(`GitHub API error ${response.status} for ${url}`);
  }

  return response.text();
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

function normalizeStep(data: Record<string, unknown>): DiagnoseCiJobStep {
  return {
    number: data.number === undefined ? undefined : Number(data.number),
    name: String(data.name ?? ''),
    status: String(data.status ?? ''),
    conclusion: data.conclusion === null || data.conclusion === undefined ? null : String(data.conclusion),
  };
}

function normalizeJob(data: Record<string, unknown>): DiagnoseCiJob {
  const rawSteps = data.steps;
  const steps: DiagnoseCiJobStep[] | undefined =
    Array.isArray(rawSteps) ? rawSteps.map((s) => normalizeStep(s as Record<string, unknown>)) : undefined;

  return {
    id: Number(data.id),
    name: String(data.name ?? ''),
    status: String(data.status ?? ''),
    conclusion: data.conclusion === null || data.conclusion === undefined ? null : String(data.conclusion),
    steps,
  };
}

export async function resolveWorkflowRunId(
  config: DiagnoseCiConfig,
  fetchFn: FetchFn
): Promise<ResolveRunIdResult> {
  if (config.mode === 'fake') {
    return { runId: 123456789, source: 'workflow_run_id' };
  }

  const baseUrl = `https://api.github.com/repos/${config.repo_slug}`;

  if (
    typeof config.target.workflow_run_id === 'number' &&
    Number.isFinite(config.target.workflow_run_id)
  ) {
    return { runId: config.target.workflow_run_id, source: 'workflow_run_id' };
  }

  // From this point on we need to call the GitHub API, so a token is required.
  const token = getToken(config);

  let headSha: string;
  let source: 'pr_number' | 'commit_sha';

  if (typeof config.target.pr_number === 'number' && Number.isFinite(config.target.pr_number)) {
    const prData = await githubJsonRequest(`${baseUrl}/pulls/${config.target.pr_number}`, token, fetchFn);
    const head = ((prData.head ?? {}) as Record<string, unknown>) || {};
    const sha = head.sha;
    if (typeof sha !== 'string' || sha.length === 0) {
      throw new Error('GitHub PR response is missing head.sha');
    }
    headSha = sha;
    source = 'pr_number';
  } else if (typeof config.target.commit_sha === 'string' && config.target.commit_sha.length > 0) {
    headSha = config.target.commit_sha;
    source = 'commit_sha';
  } else {
    throw new Error('No workflow run target could be determined from config');
  }

  const runsData = await githubJsonRequest(
    `${baseUrl}/actions/runs?head_sha=${encodeURIComponent(headSha)}&per_page=10`,
    token,
    fetchFn
  );
  const workflowRuns = Array.isArray(runsData.workflow_runs) ? runsData.workflow_runs : [];
  if (workflowRuns.length === 0) {
    throw new DiagnoseCiGithubError(
      'DIAGNOSE_CI_NOT_FOUND',
      `No workflow runs found for commit ${headSha}`
    );
  }

  const firstRun = workflowRuns[0] as Record<string, unknown>;
  return { runId: Number(firstRun.id), source };
}

export async function fetchWorkflowBundle(
  config: DiagnoseCiConfig,
  fetchFn: FetchFn
): Promise<WorkflowBundle> {
  if (config.mode === 'fake') {
    return buildFakeWorkflowBundle(config.fake_scenario ?? 'green');
  }

  const token = getToken(config);
  const resolved = await resolveWorkflowRunId(config, fetchFn);
  const baseUrl = `https://api.github.com/repos/${config.repo_slug}`;

  const runData = await githubJsonRequest(`${baseUrl}/actions/runs/${resolved.runId}`, token, fetchFn);
  const run = normalizeRun(runData);

  const jobsData = await githubJsonRequest(`${baseUrl}/actions/runs/${resolved.runId}/jobs`, token, fetchFn);
  const rawJobs = Array.isArray(jobsData.jobs) ? jobsData.jobs : [];
  const jobs = rawJobs.map((j) => normalizeJob(j as Record<string, unknown>));

  const logs: Record<string, string> = {};
  for (const job of jobs) {
    logs[job.id] = await githubTextRequest(`${baseUrl}/actions/jobs/${job.id}/logs`, token, fetchFn);
  }

  return { run, jobs, logs };
}

export function buildFakeWorkflowBundle(scenario: DiagnoseCiFakeScenario): WorkflowBundle {
  const isGreen = scenario === 'green';

  const run: DiagnoseCiWorkflowRun = {
    id: 123456789,
    run_number: 999,
    name: 'Mini-MVP CI',
    event: 'pull_request',
    branch: 'stage-18-18-demo',
    head_sha: 'abc123def456789012345678901234567890abcd',
    status: 'completed',
    conclusion: isGreen ? 'success' : 'failure',
  };

  const job: DiagnoseCiJob = {
    id: 987654321,
    name: 'checks',
    status: 'completed',
    conclusion: isGreen ? 'success' : 'failure',
    steps: [
      { number: 1, name: 'Checkout', status: 'completed', conclusion: 'success' },
      { number: 2, name: 'Install', status: 'completed', conclusion: 'success' },
      { number: 3, name: 'Test', status: 'completed', conclusion: isGreen ? 'success' : 'failure' },
    ],
  };

  const logs: Record<string, string> = {
    [job.id]: isGreen ? fakeGreenLog() : fakeRedLog(),
  };

  return { run, jobs: [job], logs };
}

function fakeGreenLog(): string {
  return [
    'Run npm test',
    'PASS: all checks completed successfully',
    'TOTAL: tests=42 suites=3 pass=42 fail=0 cancelled=0 skipped=0',
  ].join('\n');
}

function fakeRedLog(): string {
  return [
    'Run npm test',
    '# Subtest: CLI passes on current project evidence',
    'not ok 1 - CLI passes on current project evidence',
    '  ---',
    "  duration_ms: 1234",
    "  location: 'test/verify-testing-summary.test.ts:42:5'",
    "  failureType: 'testCodeFailure'",
    '  error: |-',
    '    Verifier failed: TESTING_SUMMARY verification failed: Non-summary files changed after Last verified commit (deadbeef): test/cli-mvp-run.test.ts',
    "  code: 'ERR_ASSERTION'",
    '  actual: 1',
    '  expected: 0',
    "  operator: 'strictEqual'",
    '  stack: |-',
    '    Error: Non-summary files changed after Last verified commit (deadbeef): test/cli-mvp-run.test.ts',
    '        at TestContext.<anonymous> (file:///workspace/test/verify-testing-summary.test.ts:50:10)',
    '        at Test.runInAsyncScope (node:async_hooks:206:9)',
    '  ...',
    'FAILED: one or more test chunks failed.',
    'TOTAL: tests=3674 suites=217 pass=3673 fail=1 cancelled=0 skipped=0',
    'Warning: job exceeded time limit of 10 minutes',
  ].join('\n');
}

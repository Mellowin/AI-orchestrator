import type {
  AcceptanceMatrixConfig,
  AcceptanceScenarioConfig,
  FailureClassification,
} from './types.js';

export interface GithubPrCreatorDeps {
  postJson: (
    url: string,
    headers: Record<string, string>,
    body: unknown
  ) => Promise<{ status: number; body: unknown }>;
}

export interface AcceptanceMatrixPrResult {
  created: boolean;
  number?: number;
  url?: string;
  draft: boolean;
  reason: string;
  classification?: FailureClassification;
}

function redactSecrets(text: string): string {
  return text
    .replace(/ghp_[a-zA-Z0-9]*/g, '[REDACTED]')
    .replace(/github_pat_[a-zA-Z0-9_-]*/g, '[REDACTED]')
    .replace(/Bearer\s+[\S]+/gi, 'Bearer [REDACTED]');
}

function formatReason(classification: FailureClassification, detail: string): string {
  return `[${classification}] ${redactSecrets(detail)}`;
}

function isNonEmptyString(value: string | undefined): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

async function realPostJson(
  url: string,
  headers: Record<string, string>,
  body: unknown
): Promise<{ status: number; body: unknown }> {
  const { default: https } = await import('node:https');
  const payload = JSON.stringify(body);

  return new Promise((resolve, reject) => {
    const req = https.request(
      url,
      {
        method: 'POST',
        headers: {
          ...headers,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => {
          let parsed: unknown;
          try {
            parsed = data ? JSON.parse(data) : null;
          } catch {
            parsed = data;
          }
          resolve({ status: res.statusCode ?? 0, body: parsed });
        });
      }
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function parseApiError(status: number, body: unknown): string {
  if (body && typeof body === 'object') {
    const obj = body as Record<string, unknown>;
    if (typeof obj.message === 'string') return obj.message;
    if (Array.isArray(obj.errors) && obj.errors.length > 0) {
      return JSON.stringify(obj.errors);
    }
  }
  return `GitHub API returned status ${status}`;
}

export async function createAcceptanceMatrixPr(
  config: AcceptanceMatrixConfig,
  scenario: AcceptanceScenarioConfig,
  githubToken: string,
  deps?: GithubPrCreatorDeps
): Promise<AcceptanceMatrixPrResult> {
  if (!config.allow_github_pr_create) {
    return {
      created: false,
      draft: true,
      reason: formatReason('CONFIG_ERROR', 'PR creation disabled by config.allow_github_pr_create'),
      classification: 'CONFIG_ERROR',
    };
  }

  if (!isNonEmptyString(config.sandbox_repo_slug)) {
    return {
      created: false,
      draft: true,
      reason: formatReason('CONFIG_ERROR', 'sandbox_repo_slug is required to create a PR'),
      classification: 'CONFIG_ERROR',
    };
  }

  if (!isNonEmptyString(githubToken)) {
    return {
      created: false,
      draft: true,
      reason: formatReason('HUMAN_TOKEN_PERMISSION_ERROR', 'GITHUB_TOKEN is missing'),
      classification: 'HUMAN_TOKEN_PERMISSION_ERROR',
    };
  }

  const url = `https://api.github.com/repos/${config.sandbox_repo_slug}/pulls`;
  const body = {
    title: `Acceptance matrix ${scenario.type} — ${scenario.work_branch}`,
    body: `Scenario: ${scenario.type}\nBase: ${scenario.base_branch}\nHead: ${scenario.work_branch}\n\nThis PR was created by the acceptance-matrix runner for validation only. Do not merge automatically.`,
    head: scenario.work_branch,
    base: scenario.base_branch,
    draft: true,
  };
  const headers: Record<string, string> = {
    Authorization: `Bearer ${githubToken}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };

  try {
    const post = deps?.postJson ?? realPostJson;
    const response = await post(url, headers, body);

    if (response.status === 201) {
      const pr = response.body as Record<string, unknown>;
      const number = typeof pr.number === 'number' ? pr.number : undefined;
      const urlField = typeof pr.html_url === 'string' ? pr.html_url : undefined;
      const isDraft = pr.draft === true;
      return {
        created: true,
        number,
        url: urlField,
        draft: isDraft,
        reason: 'PR created as draft',
      };
    }

    const detail = parseApiError(response.status, response.body);
    if (response.status === 401 || response.status === 403) {
      return {
        created: false,
        draft: true,
        reason: formatReason('HUMAN_TOKEN_PERMISSION_ERROR', detail),
        classification: 'HUMAN_TOKEN_PERMISSION_ERROR',
      };
    }
    return {
      created: false,
      draft: true,
      reason: formatReason('GITHUB_API_ERROR', detail),
      classification: 'GITHUB_API_ERROR',
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      created: false,
      draft: true,
      reason: formatReason('GITHUB_API_ERROR', message),
      classification: 'GITHUB_API_ERROR',
    };
  }
}

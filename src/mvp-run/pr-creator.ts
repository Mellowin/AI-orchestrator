import type { MvpRunConfig, MvpRunPrResult } from './types.js';

export interface MvpRunPrCreatorDeps {
  postJson: (
    url: string,
    headers: Record<string, string>,
    body: unknown
  ) => Promise<{ status: number; body: unknown }>;
}

function redactSecrets(text: string): string {
  return text
    .replace(/ghp_[a-zA-Z0-9]*/g, '[REDACTED]')
    .replace(/github_pat_[a-zA-Z0-9_-]*/g, '[REDACTED]')
    .replace(/Bearer\s+[\S]+/gi, 'Bearer [REDACTED]');
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

export async function createMvpRunPr(
  config: MvpRunConfig,
  githubToken: string,
  reportSummary: string,
  deps?: MvpRunPrCreatorDeps
): Promise<MvpRunPrResult> {
  if (!config.allow_github_pr_create) {
    return {
      created: false,
      reason: 'PR creation disabled by config.allow_github_pr_create',
    };
  }

  if (!isNonEmptyString(config.repo_slug)) {
    return {
      created: false,
      reason: 'repo_slug is required to create a PR',
      classification: 'CONFIG_ERROR',
    };
  }

  if (!isNonEmptyString(githubToken)) {
    return {
      created: false,
      reason: 'GITHUB_TOKEN is missing',
      classification: 'HUMAN_TOKEN_PERMISSION_ERROR',
    };
  }

  const url = `https://api.github.com/repos/${config.repo_slug}/pulls`;
  const body = {
    title: `MVP run ${config.run_id} — ${config.work_branch}`,
    body: `MVP run: ${config.run_id}\nBase: ${config.base_branch}\nHead: ${config.work_branch}\n\n${reportSummary}\n\nThis PR was created by the AI Orchestrator MVP run. Do not merge automatically.`,
    head: config.work_branch,
    base: config.base_branch,
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

    if (response.status === 422) {
      const detail = parseApiError(response.status, response.body);
      if (String(detail).includes('A pull request already exists')) {
        return {
          created: false,
          reason: `A pull request already exists for ${config.work_branch} into ${config.base_branch}`,
          classification: 'GITHUB_API_ERROR',
        };
      }
    }

    const detail = parseApiError(response.status, response.body);
    if (response.status === 401 || response.status === 403) {
      return {
        created: false,
        reason: detail,
        classification: 'HUMAN_TOKEN_PERMISSION_ERROR',
      };
    }
    return {
      created: false,
      reason: detail,
      classification: 'GITHUB_API_ERROR',
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      created: false,
      reason: redactSecrets(message),
      classification: 'GITHUB_API_ERROR',
    };
  }
}

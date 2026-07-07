import { redactSecrets } from './sandbox-preflight-repair.js';

export interface CreateDraftPullRequestInput {
  repoFullName: string;
  baseBranch: string;
  headBranch: string;
  title: string;
  body: string;
  token?: string;
}

export type CreateDraftPullRequestResult =
  | {
      ok: true;
      url: string;
      number: number;
      draft: boolean;
      base: string;
      head: string;
      existed?: boolean;
    }
  | {
      ok: false;
      status: 'skipped_missing_token';
    }
  | {
      ok: false;
      status: 'failed';
      httpStatus: number;
      message: string;
    };

function buildRepoApiUrl(repoFullName: string): string {
  const [owner, repo] = repoFullName.split('/');
  if (!owner || !repo) {
    throw new Error(`Invalid repoFullName: ${repoFullName}`);
  }
  return `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
}

export async function createDraftPullRequest(
  input: CreateDraftPullRequestInput,
  options?: { fetchFn?: typeof fetch }
): Promise<CreateDraftPullRequestResult> {
  if (!input.token || input.token.trim() === '') {
    return { ok: false, status: 'skipped_missing_token' };
  }

  const fetchFn = options?.fetchFn ?? fetch;
  const repoUrl = buildRepoApiUrl(input.repoFullName);
  const url = `${repoUrl}/pulls`;

  const body = {
    title: input.title,
    body: input.body,
    head: input.headBranch,
    base: input.baseBranch,
    draft: true,
  };

  let response: Response;
  try {
    response = await fetchFn(url, {
      method: 'POST',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${input.token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      status: 'failed',
      httpStatus: 0,
      message: redactSecrets(message),
    };
  }

  if (!response.ok) {
    const text = await response.text().catch(() => 'Unknown error');
    const redacted = redactSecrets(text);

    if (response.status === 422 && redacted.includes('A pull request already exists')) {
      const existing = await findExistingPullRequest({
        fetchFn,
        repoUrl,
        token: input.token,
        headBranch: input.headBranch,
        baseBranch: input.baseBranch,
      });
      if (existing) {
        return {
          ok: true,
          url: existing.url,
          number: existing.number,
          draft: existing.draft,
          base: existing.base,
          head: existing.head,
          existed: true,
        };
      }
    }

    return {
      ok: false,
      status: 'failed',
      httpStatus: response.status,
      message: redacted,
    };
  }

  const data = (await response.json()) as {
    html_url?: string;
    number?: number;
    draft?: boolean;
    base?: { ref?: string };
    head?: { ref?: string };
  };

  return {
    ok: true,
    url: data.html_url ?? '',
    number: typeof data.number === 'number' ? data.number : 0,
    draft: data.draft === true,
    base: data.base?.ref ?? input.baseBranch,
    head: data.head?.ref ?? input.headBranch,
    existed: false,
  };
}

async function findExistingPullRequest(options: {
  fetchFn: typeof fetch;
  repoUrl: string;
  token: string;
  headBranch: string;
  baseBranch: string;
}): Promise<{ url: string; number: number; draft: boolean; base: string; head: string } | null> {
  const parts = options.repoUrl.split('/');
  const owner = parts[parts.length - 2];
  const head = `${owner}:${options.headBranch}`;
  const searchUrl = `${options.repoUrl}/pulls?head=${encodeURIComponent(head)}&base=${encodeURIComponent(options.baseBranch)}&state=open`;

  try {
    const response = await options.fetchFn(searchUrl, {
      method: 'GET',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${options.token}`,
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });

    if (!response.ok) {
      return null;
    }

    const pulls = (await response.json()) as Array<{
      html_url?: string;
      number?: number;
      draft?: boolean;
      base?: { ref?: string };
      head?: { ref?: string };
    }>;

    if (!Array.isArray(pulls) || pulls.length === 0) {
      return null;
    }

    const pr = pulls[0];
    return {
      url: pr.html_url ?? '',
      number: typeof pr.number === 'number' ? pr.number : 0,
      draft: pr.draft === true,
      base: pr.base?.ref ?? options.baseBranch,
      head: pr.head?.ref ?? options.headBranch,
    };
  } catch {
    return null;
  }
}

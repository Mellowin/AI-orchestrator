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

export async function createDraftPullRequest(
  input: CreateDraftPullRequestInput,
  options?: { fetchFn?: typeof fetch }
): Promise<CreateDraftPullRequestResult> {
  if (!input.token || input.token.trim() === '') {
    return { ok: false, status: 'skipped_missing_token' };
  }

  const fetchFn = options?.fetchFn ?? fetch;
  const url = `https://api.github.com/repos/${encodeURIComponent(input.repoFullName)}/pulls`;

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
    return {
      ok: false,
      status: 'failed',
      httpStatus: response.status,
      message: redactSecrets(text),
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
  };
}

import type { AcceptanceMatrixConfig } from './types.js';

export interface RuntimeValidationReport {
  kimi_api_key: 'present' | 'missing';
  github_token: 'present' | 'missing';
}

export interface RuntimeValidationResult {
  ok: boolean;
  reasons: string[];
  report: RuntimeValidationReport;
}

function isNonEmptyString(value: string | undefined): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

export function validateAcceptanceMatrixRuntime(
  config: AcceptanceMatrixConfig
): RuntimeValidationResult {
  const reasons: string[] = [];
  const report: RuntimeValidationReport = {
    kimi_api_key: isNonEmptyString(process.env.KIMI_API_KEY) ? 'present' : 'missing',
    github_token: isNonEmptyString(process.env.GITHUB_TOKEN) ? 'present' : 'missing',
  };

  const isRealMode = config.provider === 'kimi' && config.allow_real_provider;

  if (isRealMode) {
    if (report.kimi_api_key === 'missing') {
      reasons.push('Real provider mode requires KIMI_API_KEY env var');
    }
    if (!isNonEmptyString(process.env.KIMI_BASE_URL)) {
      reasons.push('Real provider mode requires KIMI_BASE_URL env var');
    }
  }

  if (config.allow_github_pr_create) {
    if (report.github_token === 'missing') {
      reasons.push('GitHub PR creation requires GITHUB_TOKEN env var');
    }
    if (!isNonEmptyString(config.sandbox_repo_slug)) {
      reasons.push('GitHub PR creation requires sandbox_repo_slug');
    }
  }

  const repoMutationRequired = true; // acceptance matrix always mutates the sandbox repo
  if (repoMutationRequired) {
    if (!config.allow_real_repo_apply) {
      reasons.push('Sandbox repo mutation requires allow_real_repo_apply=true');
    }
    if (!config.allow_real_repo_commit) {
      reasons.push('Sandbox repo mutation requires allow_real_repo_commit=true');
    }
    if (!config.allow_real_repo_push) {
      reasons.push('Sandbox repo mutation requires allow_real_repo_push=true');
    }
  }

  return { ok: reasons.length === 0, reasons, report };
}

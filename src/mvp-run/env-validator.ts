import type { MvpRunConfig } from './types.js';

export interface MvpRunRuntimeValidationReport {
  kimi_api_key: 'present' | 'missing';
  kimi_base_url: 'present' | 'missing';
  kimi_model: 'present' | 'missing';
  github_token: 'present' | 'missing';
  allow_real_provider_run: 'present' | 'missing';
  allow_real_repo_apply: 'present' | 'missing';
  allow_real_repo_commit: 'present' | 'missing';
  allow_real_repo_push: 'present' | 'missing';
  allow_github_pr_create: 'present' | 'missing';
  missing_env_vars: string[];
}

export interface MvpRunRuntimeValidationResult {
  ok: boolean;
  reasons: string[];
  report: MvpRunRuntimeValidationReport;
  classification: 'CONFIG_ERROR' | 'HUMAN_TOKEN_PERMISSION_ERROR';
}

function isNonEmptyString(value: string | undefined): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

function isTruthyEnv(value: string | undefined): boolean {
  return value === 'true' || value === '1';
}

export function validateMvpRunRuntime(config: MvpRunConfig): MvpRunRuntimeValidationResult {
  const reasons: string[] = [];
  const report: MvpRunRuntimeValidationReport = {
    kimi_api_key: isNonEmptyString(process.env.KIMI_API_KEY) ? 'present' : 'missing',
    kimi_base_url: isNonEmptyString(process.env.KIMI_BASE_URL) ? 'present' : 'missing',
    kimi_model: isNonEmptyString(process.env.KIMI_MODEL) ? 'present' : 'missing',
    github_token: isNonEmptyString(process.env.GITHUB_TOKEN) ? 'present' : 'missing',
    allow_real_provider_run: isTruthyEnv(process.env.ALLOW_REAL_PROVIDER_RUN) ? 'present' : 'missing',
    allow_real_repo_apply: isTruthyEnv(process.env.ALLOW_REAL_REPO_APPLY) ? 'present' : 'missing',
    allow_real_repo_commit: isTruthyEnv(process.env.ALLOW_REAL_REPO_COMMIT) ? 'present' : 'missing',
    allow_real_repo_push: isTruthyEnv(process.env.ALLOW_REAL_REPO_PUSH) ? 'present' : 'missing',
    allow_github_pr_create: isTruthyEnv(process.env.ALLOW_GITHUB_PR_CREATE) ? 'present' : 'missing',
    missing_env_vars: [],
  };

  const isRealMode = config.provider === 'kimi' && config.allow_real_provider;

  if (isRealMode) {
    if (report.allow_real_provider_run === 'missing') {
      reasons.push('Real provider mode requires ALLOW_REAL_PROVIDER_RUN=true env var');
    }
    if (report.kimi_api_key === 'missing') {
      reasons.push('Real provider mode requires KIMI_API_KEY env var');
    }
    if (report.kimi_base_url === 'missing') {
      reasons.push('Real provider mode requires KIMI_BASE_URL env var');
    }
    if (report.kimi_model === 'missing') {
      reasons.push('Real provider mode requires KIMI_MODEL env var');
    }
  }

  if (config.allow_real_repo_apply) {
    if (report.allow_real_repo_apply === 'missing') {
      reasons.push('Repo apply requires ALLOW_REAL_REPO_APPLY=true env var');
    }
  }
  if (config.allow_real_repo_commit) {
    if (report.allow_real_repo_commit === 'missing') {
      reasons.push('Repo commit requires ALLOW_REAL_REPO_COMMIT=true env var');
    }
  }
  if (config.allow_real_repo_push) {
    if (report.allow_real_repo_push === 'missing') {
      reasons.push('Repo push requires ALLOW_REAL_REPO_PUSH=true env var');
    }
  }

  if (config.allow_github_pr_create) {
    if (report.allow_github_pr_create === 'missing') {
      reasons.push('GitHub PR creation requires ALLOW_GITHUB_PR_CREATE=true env var');
    }
    if (report.github_token === 'missing') {
      reasons.push('GitHub PR creation requires GITHUB_TOKEN env var');
    }
    if (!isNonEmptyString(config.repo_slug)) {
      reasons.push('GitHub PR creation requires repo_slug in config');
    }
  }

  report.missing_env_vars = reasons;

  const isTokenError = config.allow_github_pr_create && report.github_token === 'missing';
  const classification: MvpRunRuntimeValidationResult['classification'] = isTokenError
    ? 'HUMAN_TOKEN_PERMISSION_ERROR'
    : 'CONFIG_ERROR';

  return { ok: reasons.length === 0, reasons, report, classification };
}

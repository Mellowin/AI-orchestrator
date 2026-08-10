import { resolve, normalize, sep, basename, extname } from 'node:path';
import { matchesPattern } from './guardrails.js';

export interface AiSafetyPolicyFile {
  path: string;
  content: string;
}

export interface AiSafetyPolicyInput {
  repoPath: string;
  allowedFiles?: string[];
  deniedFiles?: string[];
  files: AiSafetyPolicyFile[];
}

export interface AiSafetyPolicyResult {
  ok: boolean;
  reasons: string[];
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, '/');
}

function isAbsolutePath(path: string): boolean {
  const normalized = normalizePath(path);
  return normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized);
}

function isInsideRepo(repoPath: string, candidatePath: string): boolean {
  const resolvedRepo = resolve(normalize(repoPath));
  const resolvedCandidate = resolve(resolvedRepo, normalize(candidatePath));
  const repoWithSep = resolvedRepo.endsWith(sep) ? resolvedRepo : resolvedRepo + sep;
  return resolvedCandidate === resolvedRepo || resolvedCandidate.startsWith(repoWithSep);
}

function isDeniedPath(path: string): boolean {
  const normalized = normalizePath(path);
  const segments = normalized.split('/').filter((s) => s.length > 0);
  for (const segment of segments) {
    if (segment === '.env' || segment === '.env.local') {
      return true;
    }
    if (segment === '.git' || segment === 'node_modules') {
      return true;
    }
  }
  return false;
}

function isAllowedPath(path: string, allowedFiles: string[]): boolean {
  const normalized = normalizePath(path);
  return allowedFiles.some((allowed) => matchesPattern(normalized, normalizePath(allowed)));
}

function isWorkflowFile(path: string): boolean {
  const normalized = normalizePath(path);
  return normalized.includes('.github/workflows/') && /\.(yml|yaml)$/i.test(normalized);
}

function isTestFileByPath(path: string): boolean {
  const normalized = normalizePath(path);
  const lowerPath = normalized.toLowerCase();
  const testPathPattern = /(^|\/|\\)tests?(\/|\\|$)|\.(test|spec)\.(js|ts|mjs|cjs)$/i;
  if (testPathPattern.test(lowerPath)) {
    return true;
  }
  const name = basename(normalized).toLowerCase();
  if (name.startsWith('test') && extname(name) === '.js') {
    return true;
  }
  return false;
}

function isTestFile(path: string, _content: string): boolean {
  return isTestFileByPath(path);
}

function getContentLines(content: string): string[] {
  return content.split(/\r?\n/);
}

function checkPathEscape(
  repoPath: string,
  path: string,
  allowedFiles: string[] | undefined,
  deniedFiles: string[] | undefined
): string[] {
  const reasons: string[] = [];
  const normalized = normalizePath(path);

  if (isAbsolutePath(path)) {
    reasons.push(`Path is absolute: ${path}`);
  }
  if (normalized.includes('..')) {
    reasons.push(`Path contains parent directory reference: ${path}`);
  }
  if (!isInsideRepo(repoPath, path)) {
    reasons.push(`Path escapes repository root: ${path}`);
  }
  if (isDeniedPath(path)) {
    reasons.push(`Path is in denied list: ${path}`);
  }
  if (deniedFiles !== undefined && deniedFiles.length > 0 && isAllowedPath(path, deniedFiles)) {
    reasons.push(`Path is in denied_files: ${path}`);
  }
  if (allowedFiles !== undefined && !isAllowedPath(path, allowedFiles)) {
    reasons.push(`Path is not in allowed_files: ${path}`);
  }
  return reasons;
}

function checkSecretExfiltration(path: string, content: string): string[] {
  const reasons: string[] = [];
  const lowerContent = content.toLowerCase();

  const sensitiveEnvPattern = /process\.env\.[A-Za-z0-9_$]*(?:kimi_api_key|api_key|secret|token|password)/i;
  if (sensitiveEnvPattern.test(content)) {
    reasons.push(`Secret env var access in ${path}`);
  }

  const bracketEnvPattern = /process\.env\s*\[\s*['"][^'"]*(?:KIMI_API_KEY|API_KEY|SECRET|TOKEN|PASSWORD)/i;
  if (bracketEnvPattern.test(content)) {
    reasons.push(`Secret env var access via bracket notation in ${path}`);
  }

  const consoleEnvPattern = /console\.(log|error|warn|info|debug)\s*\([^)]*\bprocess\.env\b[^)]*\)/i;
  if (consoleEnvPattern.test(content)) {
    reasons.push(`Logging process.env in ${path}`);
  }

  const jsonEnvPattern = /JSON\.stringify\s*\([^)]*\bprocess\.env\b[^)]*\)/i;
  if (jsonEnvPattern.test(content)) {
    reasons.push(`Serializing process.env in ${path}`);
  }

  if (/require\s*\(\s*['"]dotenv['"]\s*\)/i.test(content) || /from\s+['"]dotenv['"]/i.test(content)) {
    reasons.push(`Loading .env file in ${path}`);
  }

  if (/readFileSync\s*\(\s*['"][^'"]*\.env[^'"]*['"]/i.test(content)) {
    reasons.push(`Reading .env file in ${path}`);
  }

  if (lowerContent.includes('kimi_api_key')) {
    reasons.push(`Literal KIMI_API_KEY reference in ${path}`);
  }

  return reasons;
}

function checkTestWeakening(path: string, content: string): string[] {
  const reasons: string[] = [];
  if (!isTestFile(path, content)) {
    return reasons;
  }

  if (/\.(only|skip)\b/.test(content)) {
    reasons.push(`Test selector .only/.skip in ${path}`);
  }

  if (content.trim().length === 0) {
    reasons.push(`Test file would be empty: ${path}`);
  }

  const lines = getContentLines(content);
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('//') || trimmed.startsWith('#')) {
      const afterComment = trimmed.slice(trimmed.startsWith('//') ? 2 : 1).toLowerCase();
      if (
        afterComment.includes('assert') ||
        afterComment.includes('expect') ||
        afterComment.includes('process.exit(1)') ||
        afterComment.includes('throw new error')
      ) {
        reasons.push(`Commented-out assertion in ${path}: ${line.trim()}`);
      }
    }
  }

  const lowered = content.toLowerCase();
  const hasAssertion =
    /\bassert\b/.test(lowered) ||
    /\bexpect\b/.test(lowered) ||
    /process\.exit\s*\(\s*1\s*\)/.test(lowered) ||
    /throw\s+new\s+Error/.test(content);
  if (!hasAssertion && /console\.log\s*\(\s*['"]ok['"]\s*\)/.test(content)) {
    reasons.push(`Test ${path} has no assertions and only prints ok`);
  }

  return reasons;
}

function checkCiWeakening(path: string, content: string): string[] {
  const reasons: string[] = [];
  if (!isWorkflowFile(path)) {
    return reasons;
  }
  if (/continue-on-error\s*:/i.test(content)) {
    reasons.push(`continue-on-error in workflow ${path}`);
  }
  return reasons;
}

const CODE_LIKE_EXTENSIONS = new Set(['.js', '.ts', '.mjs', '.cjs', '.sh', '.ps1']);

function isCodeLikeFile(path: string): boolean {
  const normalized = normalizePath(path).toLowerCase();
  if (normalized.endsWith('/package.json') || normalized === 'package.json') {
    return true;
  }
  if (isWorkflowFile(path)) {
    return true;
  }
  const ext = extname(normalized);
  return CODE_LIKE_EXTENSIONS.has(ext);
}

const DANGEROUS_PATH_FRAGMENT = String.raw`(?:\.\.[\/\\]|\.[\/\\]\.\.[\/\\]|[A-Za-z]:[\/\\]|\/tmp\/|\/etc\/|\/home\/|\/var\/|\/root\/|\/opt\/|\/usr\/|\/bin\/|\/sbin\/|\/lib\/|\/lib64\/|\/proc\/|\/sys\/|\/dev\/)`;

const DANGEROUS_PATH_LITERAL = new RegExp(
  `['"](?:[^'"]*${DANGEROUS_PATH_FRAGMENT}[^'"]*)['"]`,
  'i'
);

function checkPackageJsonScripts(path: string, content: string): string[] {
  const reasons: string[] = [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return reasons;
  }
  if (typeof parsed !== 'object' || parsed === null || !('scripts' in parsed)) {
    return reasons;
  }
  const scripts = (parsed as Record<string, unknown>).scripts;
  if (typeof scripts !== 'object' || scripts === null) {
    return reasons;
  }
  for (const [name, value] of Object.entries(scripts)) {
    if (typeof value !== 'string') continue;
    if (new RegExp(String.raw`(?:>|\$|\`)\s*${DANGEROUS_PATH_FRAGMENT}`, 'i').test(value)) {
      reasons.push(`package.json script "${name}" targets dangerous path`);
    }
  }
  return reasons;
}

function checkContentLevelPathOperations(path: string, content: string): string[] {
  const reasons: string[] = [];
  if (!isCodeLikeFile(path)) {
    return reasons;
  }

  if (normalizePath(path).toLowerCase().endsWith('package.json')) {
    reasons.push(...checkPackageJsonScripts(path, content));
  }

  const fsOperationPattern = new RegExp(
    String.raw`(?:fs\.|fs\.promises\.)?(?:writeFile(?:Sync)?|readFile(?:Sync)?|appendFile(?:Sync)?|open(?:Sync)?|createWriteStream|createReadStream)\s*\(\s*${DANGEROUS_PATH_LITERAL.source}`,
    'i'
  );
  if (fsOperationPattern.test(content)) {
    reasons.push(`File operation targets dangerous path in ${path}`);
  }

  const pathJoinPattern = /path\.join\s*\(\s*['"]\.\.['"]/i;
  if (pathJoinPattern.test(content)) {
    reasons.push(`path.join with parent directory reference in ${path}`);
  }

  const childProcessPattern = new RegExp(
    String.raw`(?:child_process\s*\.\s*(?:exec(?:Sync|File(?:Sync)?)?|spawn(?:Sync)?)|\b(?:exec(?:Sync|File(?:Sync)?)?|spawn(?:Sync)?)\s*\()\s*['"][^'"]*(?:${DANGEROUS_PATH_FRAGMENT}|>\s*${DANGEROUS_PATH_FRAGMENT})[^'"]*['"]`,
    'i'
  );
  if (childProcessPattern.test(content)) {
    reasons.push(`child_process operation targets outside repository in ${path}`);
  }

  return reasons;
}

export function validateAiSafetyPolicy(input: AiSafetyPolicyInput): AiSafetyPolicyResult {
  const reasons: string[] = [];
  if (input.allowedFiles !== undefined && !Array.isArray(input.allowedFiles)) {
    return { ok: false, reasons: ['Invalid allowed_files: must be an array of strings'] };
  }
  for (const file of input.files) {
    reasons.push(...checkPathEscape(input.repoPath, file.path, input.allowedFiles, input.deniedFiles));
    reasons.push(...checkSecretExfiltration(file.path, file.content));
    reasons.push(...checkTestWeakening(file.path, file.content));
    reasons.push(...checkCiWeakening(file.path, file.content));
    reasons.push(...checkContentLevelPathOperations(file.path, file.content));
  }
  return { ok: reasons.length === 0, reasons };
}

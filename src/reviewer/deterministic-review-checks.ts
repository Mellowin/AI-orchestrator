import { redactReviewerText } from './reviewer-redaction.js';

export interface DeterministicReviewCheckResult {
  ok: boolean;
  blockingIssues: string[];
  safetyFindings: string[];
}

interface DeterministicReviewCheckInput {
  allowedFiles: string[];
  deniedFiles: string[];
  maxLinesChanged: number;
  changedFiles: string[];
  diff: string;
  typecheckResult: string;
  buildResult: string;
  testResult: string;
  gitStatus: string;
  commitSha: string;
  currentBranch?: string;
}

const PASS_PATTERNS = ['pass', 'success', 'clean', 'ok'];

function looksLikePass(result: string): boolean {
  const lower = result.trim().toLowerCase();
  const words = lower.split(/[^a-z0-9]+/);
  return PASS_PATTERNS.some((p) => words.includes(p));
}

const SECRET_PATTERNS = [
  { pattern: /sk-[A-Za-z0-9]/, label: 'sk- token' },
  { pattern: /Bearer\s+/, label: 'Bearer token' },
  { pattern: /KIMI_API_KEY/, label: 'KIMI_API_KEY' },
  { pattern: /OPENAI_API_KEY/, label: 'OPENAI_API_KEY' },
  { pattern: /ANTHROPIC_API_KEY/, label: 'ANTHROPIC_API_KEY' },
  { pattern: /GITHUB_TOKEN/, label: 'GITHUB_TOKEN' },
  { pattern: /\.env/, label: '.env file reference' },
];

const MERGE_CONFLICT_MARKERS = ['<<<<<<<', '=======', '>>>>>>>'];

const SHA_REGEX = /^[0-9a-fA-F]{40}$/;

function countChangedLines(diff: string): number {
  let count = 0;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) {
      count++;
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      count++;
    }
  }
  return count;
}

function isPathMatch(file: string, pattern: string): boolean {
  // Simple glob-like matching for ** and *
  const normalizedFile = file.replace(/\\/g, '/');
  const normalizedPattern = pattern.replace(/\\/g, '/');

  if (normalizedPattern.endsWith('/**')) {
    const prefix = normalizedPattern.slice(0, -2);
    return normalizedFile.startsWith(prefix);
  }
  if (normalizedPattern.includes('*')) {
    const regex = new RegExp('^' + normalizedPattern.replace(/\*\*/g, '<<<DOUBLESTAR>>>').replace(/\*/g, '[^/]*').replace(/<<<DOUBLESTAR>>>/g, '.*') + '$');
    return regex.test(normalizedFile);
  }
  return normalizedFile === normalizedPattern || normalizedFile.startsWith(normalizedPattern + '/');
}

export function runDeterministicReviewChecks(input: DeterministicReviewCheckInput): DeterministicReviewCheckResult {
  const blockingIssues: string[] = [];
  const safetyFindings: string[] = [];

  // Commit SHA validation
  if (!SHA_REGEX.test(input.commitSha)) {
    blockingIssues.push('Commit SHA is not a valid full 40-character hex string');
    safetyFindings.push('Invalid commit SHA format');
  }

  // Empty changed files
  if (input.changedFiles.length === 0) {
    blockingIssues.push('No changed files detected');
    safetyFindings.push('Commit contains no file changes');
  }

  // Allowed files check
  if (input.allowedFiles.length === 0) {
    blockingIssues.push('allowedFiles is empty: no files are permitted to change');
    safetyFindings.push('Empty allowedFiles list');
  } else {
    for (const file of input.changedFiles) {
      const isAllowed = input.allowedFiles.some((pattern) => isPathMatch(file, pattern));
      if (!isAllowed) {
        blockingIssues.push(`Changed file "${file}" is not in allowedFiles`);
        safetyFindings.push(`File outside allowed scope: ${file}`);
      }
    }
  }

  // Denied files check
  for (const file of input.changedFiles) {
    for (const denied of input.deniedFiles) {
      if (isPathMatch(file, denied)) {
        blockingIssues.push(`Denied file "${file}" was touched (matches pattern "${denied}")`);
        safetyFindings.push(`Denied file touched: ${file}`);
      }
    }
  }

  // Max lines changed
  if (input.maxLinesChanged <= 0) {
    blockingIssues.push(`maxLinesChanged (${input.maxLinesChanged}) must be positive`);
    safetyFindings.push('Invalid maxLinesChanged value');
  } else {
    const changedLineCount = countChangedLines(input.diff);
    if (changedLineCount > input.maxLinesChanged) {
      blockingIssues.push(`Changed lines (${changedLineCount}) exceed maxLinesChanged (${input.maxLinesChanged})`);
      safetyFindings.push(`Line delta exceeded: ${changedLineCount} > ${input.maxLinesChanged}`);
    }
  }

  // Typecheck/build/test results
  if (!looksLikePass(input.typecheckResult)) {
    blockingIssues.push(`Typecheck did not pass: ${redactReviewerText(input.typecheckResult)}`);
    safetyFindings.push('Typecheck failure');
  }
  if (!looksLikePass(input.buildResult)) {
    blockingIssues.push(`Build did not pass: ${redactReviewerText(input.buildResult)}`);
    safetyFindings.push('Build failure');
  }
  if (!looksLikePass(input.testResult)) {
    blockingIssues.push(`Tests did not pass: ${redactReviewerText(input.testResult)}`);
    safetyFindings.push('Test failure');
  }

  // Git status
  const cleanStatus = input.gitStatus.trim() === '';
  if (!cleanStatus) {
    blockingIssues.push(`Working tree is not clean: ${redactReviewerText(input.gitStatus)}`);
    safetyFindings.push('Dirty working tree detected');
  }

  // Current branch
  if (input.currentBranch === 'main') {
    blockingIssues.push('Current branch is main');
    safetyFindings.push('main branch violation');
  }

  // Secret detection in diff
  for (const { pattern, label } of SECRET_PATTERNS) {
    if (pattern.test(input.diff)) {
      blockingIssues.push(`Possible secret detected in diff: ${label}`);
      safetyFindings.push(`Secret pattern detected: ${label}`);
    }
  }

  // Merge conflict markers
  for (const marker of MERGE_CONFLICT_MARKERS) {
    if (input.diff.includes(marker)) {
      blockingIssues.push(`Merge conflict marker detected in diff: ${marker}`);
      safetyFindings.push('Merge conflict markers in diff');
    }
  }

  return {
    ok: blockingIssues.length === 0,
    blockingIssues,
    safetyFindings,
  };
}

import type { ReviewInput } from './reviewer-types.js';

export function buildReviewerPrompt(input: ReviewInput): string {
  const safetySection =
    input.safety_findings.length > 0
      ? input.safety_findings.map((f) => `- ${f}`).join('\n')
      : '- No safety issues detected';

  const previousFailureSection = input.previous_failure
    ? `\n# Previous Failure\n${input.previous_failure}\n`
    : '';

  const acceptanceSection =
    input.acceptance_criteria && input.acceptance_criteria.length > 0
      ? input.acceptance_criteria.map((c) => `- ${c}`).join('\n')
      : '- No specific acceptance criteria provided; use the task goal as the acceptance bar';

  const evidence = input.dependency_evidence;
  const dependencyEvidenceSection = buildDependencyEvidenceSection(evidence);
  const readOnlyContextSection = buildReadOnlyContextSection(input.read_only_context);
  const candidateSection = buildCandidateSection(input.candidate_state);
  const commitSection = buildCommitSection(input);

  const header = input.candidate_state
    ? `You are a strict AI code reviewer.\n\n` +
      `You review the exact pre-commit staged candidate evidence below. ` +
      `The candidate intentionally has no commit until it is accepted. ` +
      `Do NOT require a post-commit SHA as evidence; the candidate package hash is the identity of the change.\n\n`
    : `You are a strict AI code reviewer.\n\n` +
      `You review factual evidence only. You do NOT trust the coder's self-report. You look at actual commits, diffs, and check results.\n\n`;

  return (
    header +
    `# Task Goal\n${input.task_goal}\n\n` +
    `${previousFailureSection}` +
    `# Allowed Files\n${input.allowed_files.map((f) => `- ${f}`).join('\n') || '- none specified'}\n\n` +
    `# Denied Files\n${input.denied_files.map((f) => `- ${f}`).join('\n') || '- none specified'}\n\n` +
    `# Max Lines Changed (advisory budget)\n${input.max_lines_changed ?? 'not specified'}\n\n` +
    `# Acceptance Criteria (task-level)\n${acceptanceSection}\n\n` +
    `${candidateSection}` +
    `${commitSection}` +
    `# Changed Files\n${input.changed_files.map((f) => `- ${f}`).join('\n') || '- none'}\n\n` +
    `# Diff\n\`\`\`diff\n${input.diff}\n\`\`\`\n\n` +
    `${readOnlyContextSection}` +
    `${dependencyEvidenceSection}` +
    `# Dependency Evidence Rules\n` +
    `- The files above are read-only context from previously accepted ancestor tasks or from the repository source tree.\n` +
    `- Do NOT request changes to dependency files or source context files; the current task scope is the only writable scope.\n` +
    `- A fix task may modify ONLY the current task allowed_files listed above.\n\n` +
    `# Deterministic Check Results\n` +
    `- Typecheck: ${input.typecheck_result}\n` +
    `- Build: ${input.build_result}\n` +
    `- Tests: ${input.test_result}\n` +
    `- Git status: ${input.git_status}\n\n` +
    `# Safety Findings\n${safetySection}\n\n` +
    `# Review Rules\n` +
    `You MUST reject if ANY of the following is true:\n` +
    `- Task goal is not satisfied\n` +
    `- ANY acceptance criterion is not satisfied (if acceptance criteria are provided, treat each as a hard requirement)\n` +
    `- Changed files exceed allowed_files scope\n` +
    `- Denied files were touched\n` +
    `- max_lines_changed exceeded as a HARD safety rule (only if the user explicitly configured a hard limit)\n` +
    `- Typecheck/build/tests failed\n` +
    `- Commit hash is missing or invalid (only when reviewing an already-committed change)\n` +
    `- Candidate package hash is missing or does not match the diff (when reviewing a pre-commit candidate)\n` +
    `- Secrets or API keys appear in changed files\n` +
    `- main/merge/force push safety was violated\n` +
    `- Changed path contains \\"..\\", is absolute, or escapes the repository root\n` +
    `- Changed path touches .env, .env.local, .git, or node_modules\n` +
    `- Change reads .env, loads dotenv, logs process.env, or references KIMI_API_KEY or other secrets\n` +
    `- Change disables tests by commenting out assertions, adding .only/.skip, or emptying test files\n` +
    `- Change adds continue-on-error to CI workflow files\n` +
    `- Change removes validation, uses broad catch blocks that swallow errors, or weakens safety checks\n` +
    `- You cannot determine correctness from the evidence\n\n` +
    `You MUST accept ONLY if ALL of the following are true:\n` +
    `- Task goal is satisfied\n` +
    `- ALL acceptance criteria are satisfied (if any are provided)\n` +
    `- Deterministic checks passed\n` +
    `- Changed files are within scope\n` +
    `- No safety issue exists\n\n` +
    `# Output Format\n` +
    `Return ONLY a single JSON object. No markdown. No extra text. No code fences.\n\n` +
    `Required JSON schema:\n` +
    `{\n` +
    `  "decision": "accepted | rejected",\n` +
    `  "confidence": "low | medium | high",\n` +
    `  "blocking_issues": ["..."],\n` +
    `  "non_blocking_issues": ["..."],\n` +
    `  "review_summary": "...",\n` +
    `  "fix_task": "... | null",\n` +
    `  "next_action": "advance_to_next_task | send_fix_to_coder | block_for_human"\n` +
    `}`
  );
}

function buildCandidateSection(
  candidateState: ReviewInput['candidate_state']
): string {
  if (!candidateState) {
    return '';
  }
  const fileList = candidateState.files
    .map(
      (f) =>
        `- ${f.path}\n` +
        `  bytes: ${f.bytes}, lines: ${f.lines}, sha256: ${f.sha256}`
    )
    .join('\n');

  return (
    `# Candidate Base SHA\n${candidateState.base_sha}\n\n` +
    `# Candidate Package Hash\n${candidateState.package_hash}\n\n` +
    `# Candidate State\npre-commit staged candidate\n\n` +
    `# Candidate File Metadata\n${fileList || '- none'}\n\n`
  );
}

function buildCommitSection(input: ReviewInput): string {
  if (input.candidate_state) {
    return '';
  }
  return `# Commit SHA\n${input.commit_sha}\n\n`;
}

function buildReadOnlyContextSection(
  context: ReviewInput['read_only_context']
): string {
  if (!context || context.files.length === 0) {
    return '';
  }
  const header =
    `## Read-Only Repository Context\n` +
    `Total size: ${context.total_bytes} bytes${context.truncated ? ' (truncated)' : ''}\n\n`;
  const items = context.files
    .map(
      (f) =>
        `- path: ${f.path}\n` +
        `  bytes: ${f.bytes}, lines: ${f.lines}, sha256: ${f.sha256}${f.truncated ? ' [truncated]' : ''}\n` +
        `  content:\n\`\`\`\n${f.content}\n\`\`\``
    )
    .join('\n\n');
  return `${header}${items}\n\n`;
}

function buildDependencyEvidenceSection(
  evidence: ReviewInput['dependency_evidence']
): string {
  if (!evidence) {
    return '';
  }
  if (evidence.items.length === 0) {
    return '## Dependency Evidence\nNo accepted ancestor artifacts available.\n\n';
  }
  const header =
    `## Dependency Evidence (read-only context from accepted ancestor tasks)\n` +
    `Total size: ${evidence.total_bytes} bytes${evidence.truncated ? ` (truncated; ${evidence.omitted_count} item(s) omitted)` : ''}\n\n`;
  const items = evidence.items
    .map(
      (item) =>
        `- task: ${item.task_id} (${item.task_status})\n` +
        `  path: ${item.path}\n` +
        `  sha256: ${item.content_sha256}\n` +
        `  bytes: ${item.bytes}, lines: ${item.lines}${item.truncated ? ' [truncated]' : ''}\n` +
        `  content:\n\`\`\`\n${item.content}\n\`\`\``
    )
    .join('\n\n');
  return `${header}${items}\n\n`;
}

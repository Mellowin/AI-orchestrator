import { spawnSync } from 'node:child_process';
import type { AutopilotRunResult } from '../../autopilot-run/types.js';
import type { FinalReviewInput, MultitaskMissionFinalReview, MultitaskMissionTaskState } from './types.js';

export type FinalReviewCallFn = (prompt: string) => Promise<string>;

function collectDiff(repoPath: string, baseBranch: string, workBranch: string): string {
  const result = spawnSync('git', ['diff', `${baseBranch}...${workBranch}`], {
    cwd: repoPath,
    encoding: 'utf-8',
    shell: false,
  });
  if (result.status !== 0) {
    return `// Could not collect diff: ${result.stderr}`;
  }
  return result.stdout ?? '';
}

function collectUnauthorizedFiles(
  diff: string,
  allowedFiles: string[]
): string[] {
  const allowedSet = new Set(allowedFiles.map((f) => f.replace(/\\/g, '/')));
  const files = new Set<string>();
  const diffIndexRe = /^diff --git a\/(.+?) b\/(.+?)$/gm;
  let match: RegExpExecArray | null;
  while ((match = diffIndexRe.exec(diff)) !== null) {
    const file = match[2];
    if (!allowedSet.has(file)) {
      files.add(file);
    }
  }
  return Array.from(files);
}

function collectAcceptanceGaps(
  taskStates: MultitaskMissionTaskState[],
  expectedResults: Map<string, string>
): string[] {
  const gaps: string[] = [];
  for (const state of taskStates) {
    if (state.status !== 'accepted' && state.status !== 'fixed_and_accepted') {
      const expected = expectedResults.get(state.task_id);
      gaps.push(`Task ${state.task_id} (${expected ?? 'no expected result recorded'}) is ${state.status}`);
    }
  }
  return gaps;
}

function buildReviewPrompt(input: FinalReviewInput): string {
  const taskSummary = input.plan.tasks
    .map((t, i) => {
      const state = input.taskStates?.find((s) => s.task_id === t.id);
      const status = state ? ` [${state.status}]` : '';
      return (
        `${i + 1}. ${t.id}: ${t.title}${status}\n` +
        `   Goal: ${t.goal}\n` +
        `   Allowed files: ${t.allowed_files.join(', ')}` +
        (t.depends_on?.length ? `\n   Depends on: ${t.depends_on.join(', ')}` : '') +
        `\n   Acceptance criteria: ${(t.acceptance_criteria ?? []).join('; ')}` +
        `\n   Expected result: ${t.expected_result ?? 'not specified'}`
      );
    })
    .join('\n');

  const autopilot = input.autopilotResult;
  const ciInfo = autopilot.ci_run_id !== undefined ? `CI run ${autopilot.ci_run_id}: ${autopilot.ci_conclusion ?? 'unknown'}` : 'CI not observed';

  return [
    'You are a senior code reviewer. Review the completed multi-task mission below.',
    '',
    '## Mission goal',
    input.mission.goal,
    '',
    '## Constraints',
    input.mission.constraints && input.mission.constraints.length > 0
      ? input.mission.constraints.map((c) => `- ${c}`).join('\n')
      : '- None',
    '',
    '## Task plan',
    taskSummary,
    '',
    '## Autopilot result',
    `- Verdict: ${autopilot.verdict}`,
    `- Reason: ${autopilot.reason}`,
    `- ${ciInfo}`,
    `- Repair attempts: ${autopilot.repair_attempts}`,
    '',
    '## Integrated diff (base..work branch)',
    '```diff',
    input.integratedDiff?.slice(0, 8000) ?? '// diff not available',
    '```',
    '',
    'Return ONLY a JSON object inside a markdown code block matching this schema:',
    '{',
    '  "verdict": "approved" | "approved_with_caveats" | "needs_changes" | "rejected",',
    '  "summary": "string",',
    '  "caveats": ["string"],',
    '  "unauthorized_files": ["string"],',
    '  "acceptance_gaps": ["string"]',
    '}',
    '',
    'Rules:',
    '- Reject if any required task is failed, blocked, skipped, or needs human.',
    '- Reject if the diff touches files outside the union of task allowed_files.',
    '- Reject if acceptance criteria are not met or the expected results are not realized.',
    '- Reject false greens where the autopilot verdict is green but tasks or diff show problems.',
    '- Approve with caveats only for minor, documented issues.',
    '- Be concise.',
  ].join('\n');
}

function extractJsonBlock(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced && fenced[1]) {
    return fenced[1].trim();
  }
  return text.trim();
}

function parseReviewJson(text: string): MultitaskMissionFinalReview {
  const jsonText = extractJsonBlock(text);
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    throw new Error('Final review response is not valid JSON');
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Final review response is not a JSON object');
  }
  const obj = parsed as Record<string, unknown>;
  const verdict = obj.verdict;
  if (
    verdict !== 'approved' &&
    verdict !== 'approved_with_caveats' &&
    verdict !== 'needs_changes' &&
    verdict !== 'rejected'
  ) {
    throw new Error(`Invalid final review verdict: ${String(verdict)}`);
  }
  const summary = typeof obj.summary === 'string' ? obj.summary : '';
  const caveats = Array.isArray(obj.caveats) ? obj.caveats.filter((c): c is string => typeof c === 'string') : [];
  const unauthorized_files = Array.isArray(obj.unauthorized_files)
    ? obj.unauthorized_files.filter((c): c is string => typeof c === 'string')
    : [];
  const acceptance_gaps = Array.isArray(obj.acceptance_gaps)
    ? obj.acceptance_gaps.filter((c): c is string => typeof c === 'string')
    : [];
  return { verdict, summary, caveats, unauthorized_files, acceptance_gaps };
}

function deterministicFallback(input: FinalReviewInput): MultitaskMissionFinalReview {
  const autopilot = input.autopilotResult;
  const expectedResults = new Map(input.plan.tasks.map((t) => [t.id, t.expected_result ?? '']));
  const gaps = collectAcceptanceGaps(input.taskStates ?? [], expectedResults);
  const unauthorized = input.integratedDiff
    ? collectUnauthorizedFiles(
        input.integratedDiff,
        input.plan.tasks.flatMap((t) => t.allowed_files)
      )
    : [];

  if (unauthorized.length > 0 || gaps.length > 0) {
    return {
      verdict: 'rejected',
      summary: `Mission review failed: ${gaps.length > 0 ? `${gaps.length} task(s) not accepted` : ''} ${unauthorized.length > 0 ? `unauthorized files: ${unauthorized.join(', ')}` : ''}`.trim(),
      caveats: [...gaps, ...unauthorized.map((f) => `Unauthorized file: ${f}`)],
      unauthorized_files: unauthorized,
      acceptance_gaps: gaps,
    };
  }

  if (autopilot.verdict === 'AUTOPILOT_GREEN') {
    return {
      verdict: 'approved',
      summary: 'Autopilot run completed green; deterministic mission review passed.',
      caveats: [],
    };
  }
  if (autopilot.verdict === 'AUTOPILOT_MVP_DONE_CI_NOT_OBSERVED') {
    return {
      verdict: 'approved_with_caveats',
      summary: 'MVP run passed; CI was not observed per configuration.',
      caveats: ['CI observation was disabled.'],
    };
  }

  return {
    verdict: 'needs_changes',
    summary: `Autopilot did not finish green: ${autopilot.verdict}.`,
    caveats: [autopilot.reason],
    acceptance_gaps: gaps,
  };
}

export async function runMissionFinalReview(
  input: FinalReviewInput,
  reviewerCallFn?: FinalReviewCallFn
): Promise<MultitaskMissionFinalReview> {
  if (!reviewerCallFn) {
    return deterministicFallback(input);
  }

  const prompt = buildReviewPrompt(input);
  const raw = await reviewerCallFn(prompt);
  return parseReviewJson(raw);
}

export { collectDiff, collectUnauthorizedFiles, collectAcceptanceGaps };

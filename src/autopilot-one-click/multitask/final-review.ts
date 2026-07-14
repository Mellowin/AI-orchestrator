import type { AutopilotRunResult } from '../../autopilot-run/types.js';
import type { FinalReviewInput, MultitaskMissionFinalReview } from './types.js';

export type FinalReviewCallFn = (prompt: string) => Promise<string>;

function buildReviewPrompt(input: FinalReviewInput): string {
  const taskSummary = input.plan.tasks
    .map(
      (t, i) =>
        `${i + 1}. ${t.id}: ${t.title}\n   Goal: ${t.goal}\n   Allowed files: ${t.allowed_files.join(', ')}` +
        (t.depends_on?.length ? `\n   Depends on: ${t.depends_on.join(', ')}` : '')
    )
    .join('\n');

  const autopilot = input.autopilotResult;
  const ciInfo = autopilot.ci_run_id !== undefined ? `CI run ${autopilot.ci_run_id}: ${autopilot.ci_conclusion ?? 'unknown'}` : 'CI not observed';

  return [
    'You are a senior code reviewer. Review the completed multi-task mission below.',
    '',
    '## Mission',
    input.mission.goal,
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
    'Return ONLY a JSON object inside a markdown code block matching this schema:',
    '{',
    '  "verdict": "approved" | "approved_with_caveats" | "needs_changes" | "rejected",',
    '  "summary": "string",',
    '  "caveats": ["string"]',
    '}',
    '',
    'Be concise. If CI is green and all tasks passed, approve. List concrete caveats only when relevant.',
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
  return { verdict, summary, caveats };
}

function deterministicFallback(input: FinalReviewInput): MultitaskMissionFinalReview {
  const autopilot = input.autopilotResult;
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

import { parseShellCheckString, validateCheck } from '../runner.js';
import type { Check } from '../types.js';
import type {
  AutopilotPlanGeneratedPlan,
  AutopilotPlanMission,
  AutopilotPlanTask,
} from './types.js';
import { validateGeneratedPlan } from '../autopilot-one-click/multitask/plan-validator.js';
import type { PlanValidationIssue } from '../autopilot-one-click/multitask/plan-validator.js';
import { validateTaskScope } from '../task-scope-validator.js';

export interface PlannerAttempt {
  attempt: number;
  raw_response_length: number;
  raw_response_excerpt: string;
  validation_error?: string;
  conflicting_task_id?: string;
  allowed_pattern?: string;
  denied_pattern?: string;
  decision: 'retry' | 'accept' | 'fail';
}

export class ProviderBadOutputError extends Error {
  attempts?: PlannerAttempt[];
  constructor(message: string, attempts?: PlannerAttempt[]) {
    super(message);
    this.name = 'ProviderBadOutputError';
    this.attempts = attempts;
  }
}

const MAX_PLAN_ATTEMPTS = 3;

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isString);
}

function isValidRisk(value: unknown): value is 'low' | 'medium' | 'high' {
  return value === 'low' || value === 'medium' || value === 'high';
}

function isOptionalStringArray(value: unknown): value is string[] | undefined {
  return value === undefined || isStringArray(value);
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || (typeof value === 'string' && value.length > 0);
}

function isOptionalPositiveInteger(value: unknown): value is number | undefined {
  return value === undefined || (typeof value === 'number' && Number.isInteger(value) && value > 0);
}

function isValidCheckEntry(
  c: unknown,
  repoPath: string
): { ok: boolean; reason?: string } {
  if (typeof c === 'string') {
    try {
      parseShellCheckString(c);
      return { ok: true };
    } catch (err) {
      return {
        ok: false,
        reason: err instanceof Error ? err.message : 'Invalid check string',
      };
    }
  }
  if (!c || typeof c !== 'object') {
    return { ok: false, reason: 'Check entry must be a string or an object' };
  }
  const o = c as Record<string, unknown>;
  if (typeof o.command !== 'string' || o.command.length === 0) {
    return { ok: false, reason: 'Structured check must have a non-empty command string' };
  }
  if (!Array.isArray(o.args) || !o.args.every((a) => typeof a === 'string')) {
    return { ok: false, reason: 'Structured check args must be an array of strings' };
  }
  if (o.cwd !== undefined && typeof o.cwd !== 'string') {
    return { ok: false, reason: 'Structured check cwd must be a string' };
  }
  const validation = validateCheck(repoPath, o as unknown as Check);
  if (!validation.ok) {
    return { ok: false, reason: validation.reason };
  }
  return { ok: true };
}

function validateTask(obj: unknown, repoPath: string): AutopilotPlanTask {
  if (!obj || typeof obj !== 'object') {
    throw new ProviderBadOutputError('Task is not an object');
  }
  const raw = obj as Record<string, unknown>;

  if (!isString(raw.id) || raw.id.length === 0) {
    throw new ProviderBadOutputError('Task missing non-empty id');
  }
  if (!isString(raw.title) || raw.title.length === 0) {
    throw new ProviderBadOutputError('Task missing non-empty title');
  }
  if (!isString(raw.goal) || raw.goal.length === 0) {
    throw new ProviderBadOutputError('Task missing non-empty goal');
  }
  if (!isStringArray(raw.allowed_files) || raw.allowed_files.length === 0) {
    throw new ProviderBadOutputError('Task missing allowed_files array');
  }
  if (raw.denied_files !== undefined && !isStringArray(raw.denied_files)) {
    throw new ProviderBadOutputError('Task denied_files must be an array of strings');
  }
  if (raw.tests !== undefined && !isStringArray(raw.tests)) {
    throw new ProviderBadOutputError('Task tests must be an array of strings');
  }
  if (raw.checks !== undefined) {
    if (!Array.isArray(raw.checks)) {
      throw new ProviderBadOutputError(
        'Task checks must be an array of strings or structured checks with command and args'
      );
    }
    const checkReasons: string[] = [];
    for (const c of raw.checks) {
      const validation = isValidCheckEntry(c, repoPath);
      if (!validation.ok) {
        checkReasons.push(validation.reason ?? 'Invalid check');
      }
    }
    if (checkReasons.length > 0) {
      throw new ProviderBadOutputError(
        `Task checks contain invalid entries: ${checkReasons.join('; ')}`
      );
    }
  }
  if (!isValidRisk(raw.risk)) {
    throw new ProviderBadOutputError("Task risk must be 'low', 'medium', or 'high'");
  }
  if (!isOptionalStringArray(raw.depends_on)) {
    throw new ProviderBadOutputError('Task depends_on must be an array of task id strings');
  }
  if (!isOptionalStringArray(raw.acceptance_criteria)) {
    throw new ProviderBadOutputError('Task acceptance_criteria must be an array of strings');
  }
  if (!isOptionalString(raw.expected_result)) {
    throw new ProviderBadOutputError('Task expected_result must be a non-empty string when provided');
  }
  if (!isOptionalPositiveInteger(raw.max_lines_changed)) {
    throw new ProviderBadOutputError('Task max_lines_changed must be a positive integer when provided');
  }

  const task: AutopilotPlanTask = {
    id: raw.id,
    title: raw.title,
    goal: raw.goal,
    allowed_files: raw.allowed_files,
    risk: raw.risk,
  };
  if (raw.denied_files) {
    task.denied_files = raw.denied_files;
  }
  if (raw.tests) {
    task.tests = raw.tests;
  }
  if (raw.checks) {
    task.checks = raw.checks as (string | Check)[];
  }
  if (raw.depends_on) {
    task.depends_on = raw.depends_on;
  }
  if (raw.acceptance_criteria) {
    task.acceptance_criteria = raw.acceptance_criteria;
  }
  if (raw.expected_result) {
    task.expected_result = raw.expected_result;
  }
  if (raw.max_lines_changed) {
    task.max_lines_changed = raw.max_lines_changed;
  }

  return task;
}

export function generateFakePlan(mission: AutopilotPlanMission): AutopilotPlanGeneratedPlan {
  const goalLower = mission.goal.toLowerCase();
  const isDocMission = goalLower.includes('doc') || goalLower.includes('readme');

  const allowedFiles = mission.allowed_files?.length
    ? mission.allowed_files
    : isDocMission
      ? ['docs/AUTOPILOT_PLAN.md']
      : ['docs/AUTOPILOT_PLAN.md', 'README.md'];

  const task: AutopilotPlanTask = {
    id: 'mission-task-1',
    title: mission.goal.slice(0, 80),
    goal: mission.goal,
    allowed_files: allowedFiles,
    denied_files: ['.env', 'node_modules/**'],
    checks: [],
    risk: 'low',
    acceptance_criteria: ['Mission goal is reflected in allowed files without touching denied files'],
    expected_result: 'Allowed files updated to satisfy the goal',
    max_lines_changed: 100,
  };

  return {
    goal: mission.goal,
    mode: mission.mode,
    tasks: [task],
    ci_enabled: false,
    repair_enabled: false,
    risk_level: 'low',
    caveats: ['Plan generated deterministically in fake/safe mode.'],
  };
}

function extractJsonBlock(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced && fenced[1]) {
    return fenced[1].trim();
  }
  return text.trim();
}

function extractConflictPatterns(message: string): { allowed?: string; denied?: string } {
  const match = message.match(/allowed pattern "([^"]+)" overlaps denied pattern "([^"]+)"/);
  if (match) {
    return { allowed: match[1], denied: match[2] };
  }
  return {};
}

function extractTaskIdFromField(field: string): string | undefined {
  const match = field.match(/tasks\[(\d+)\]/);
  return match ? match[1] : undefined;
}

function buildPlanPrompt(mission: AutopilotPlanMission): string {
  return [
    'Generate a concise task plan for the following mission.',
    '',
    `Repository: ${mission.repo_slug}`,
    `Goal: ${mission.goal}`,
    `Mode: ${mission.mode}`,
    `Base branch: ${mission.base_branch}`,
    `Work branch suggestion: mission-${mission.run_id}`,
    '',
    'Capabilities allowed by the operator:',
    `- Real AI provider: ${mission.capabilities.allow_real_provider}`,
    `- Apply code changes: ${mission.capabilities.allow_repo_apply}`,
    `- Commit changes: ${mission.capabilities.allow_repo_commit}`,
    `- Push changes: ${mission.capabilities.allow_repo_push}`,
    `- Create PRs: ${mission.capabilities.allow_pr_create}`,
    `- Update PRs: ${mission.capabilities.allow_pr_update}`,
    `- Read GitHub Actions: ${mission.capabilities.allow_actions_read}`,
    `- Autopilot repair loop: ${mission.capabilities.allow_repair}`,
    '',
    mission.constraints && mission.constraints.length > 0
      ? `Constraints:\n${mission.constraints.map((c) => `- ${c}`).join('\n')}`
      : '',
    mission.allowed_files && mission.allowed_files.length > 0
      ? `Allowed files (the AI may only modify files within this mission scope):\n${mission.allowed_files.map((f) => `- ${f}`).join('\n')}\nEach task must use the narrowest task-specific allowed_files that is a subset of this mission scope. When a task creates a specific file such as docs/proofs/STAGE_18_26_PROOF10_PART3.md, its allowed_files should be exactly that file, not the broader mission wildcard.`
      : '',
    '',
    'Return JSON matching this schema exactly:',
    '{',
    '  "tasks": [',
    '    {',
    '      "id": "string",',
    '      "title": "string",',
    '      "goal": "string",',
    '      "allowed_files": ["string"],',
    '      "denied_files": ["string"],',
    '      "tests": ["string"],',
    '      "checks": ["string" | {"command": "string", "args": ["string"], "cwd": "string?"}],',
    '      "risk": "low" | "medium" | "high",',
    '      "depends_on": ["task_id"],',
    '      "acceptance_criteria": ["string"],',
    '      "expected_result": "string",',
    '      "max_lines_changed": number',
    '    }',
    '  ],',
    '  "ci_enabled": boolean,',
    '  "repair_enabled": boolean,',
    '  "risk_level": "low" | "medium" | "high",',
    '  "caveats": ["string"]',
    '}',
    '',
    'Use `checks` for deterministic verification commands; `tests` is accepted for backward compatibility.',
    'Each check must be either a simple command string like "npm test" or a structured object: {"command": "npm", "args": ["test"], "cwd": "demo-repo"}.',
    'Use the structured object form with a relative `cwd` when a check must run inside a subdirectory of the repository (e.g., a demo project inside a nested folder).',
    'Do NOT use shell operators such as &&, ||, ;, |, >, <, backticks, or $() in checks.',
    'Do NOT use the `cd` command in a check; set `cwd` instead.',
    'For documentation-only changes with no automated verification, use an empty checks array.',
    'Do not put human-readable instructions or sentences into checks/tests.',
    'Use `depends_on` to build a valid DAG. A task may only depend on tasks listed earlier in the tasks array.',
    'Generate the smallest number of tasks that achieves the goal.',
    'Do not create separate tasks for commit, push, PR creation, or CI observation; the autopilot runner handles those automatically.',
    'Each task should describe a concrete file or code change, not a git or GitHub operation.',
    '`max_lines_changed` is a HARD UPPER BOUND on the absolute line delta for any single file in the task.',
    'For a newly created file the limit applies to the full file length, not just the diff against an empty file.',
    'Choose a realistic budget that is large enough to satisfy the acceptance criteria, but never invent an arbitrary small limit that cannot hold the required content.',
    'The coder must produce output that fits within this budget; if the task cannot be completed within the limit, the mission will fail.',
    'Task guardrail rules:',
    '- `denied_files` must never overlap `allowed_files`.',
    '- Never return `denied_files: ["**/*"]` when `allowed_files` is non-empty.',
    '- Use an empty `denied_files` array when no additional exclusions are needed.',
    '- Built-in sensitive-file protection (`.env`, `.git`, `node_modules`, traversal, absolute paths) is already applied by the system.',
    '- Every task must have at least one achievable writable scope.',
    '- Task `allowed_files` must be a subset of the mission allowed scope; never expand it.',
    '- Prefer the narrowest task-specific allowlist. If a task creates a single concrete file, set `allowed_files` to exactly that file.',
    'For summary/aggregation tasks that depend on earlier artifacts (e.g., a PART5 file that references PART1–PART4):',
    '- Set `allowed_files` to the exact output file path for the summary task, never to the broad dependency files.',
    '- Use `depends_on` to declare all ancestor tasks that produce the referenced artifacts.',
    '- Include in `acceptance_criteria` explicit requirements to reference/link to each dependency artifact (e.g., "must reference docs/proofs/PART1.md").',
    '- The system will provide read-only dependency evidence automatically; do not broaden the write scope to read dependency files.',
  ]
    .filter(Boolean)
    .join('\n');
}

function formatIssuesForCorrection(issues: PlanValidationIssue[]): string {
  return issues.map((i) => `- ${i.field}: ${i.message}`).join('\n');
}

export async function generateProviderPlan(
  mission: AutopilotPlanMission,
  providerCallFn: (prompt: string, system?: string) => Promise<unknown>
): Promise<{ plan: AutopilotPlanGeneratedPlan; attempts: PlannerAttempt[] }> {
  const system =
    'You are a safe software planning assistant. Respond with a single JSON object inside a markdown code block. Do not include explanations outside the JSON block.';

  const basePrompt = buildPlanPrompt(mission);
  const attempts: PlannerAttempt[] = [];
  let lastIssues: PlanValidationIssue[] = [];

  for (let attempt = 1; attempt <= MAX_PLAN_ATTEMPTS; attempt += 1) {
    const prompt =
      lastIssues.length > 0
        ? `${basePrompt}\n\nThe previous plan attempt was invalid. Fix the following validation errors and return the corrected full plan JSON in the same schema:\n${formatIssuesForCorrection(lastIssues)}\n\nDo not explain; return only the JSON code block.`
        : basePrompt;

    const rawResponse = await providerCallFn(prompt, system);
    const text = typeof rawResponse === 'string' ? rawResponse : JSON.stringify(rawResponse);
    const jsonText = extractJsonBlock(text);
    const excerpt = text.slice(0, 200);

    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonText);
    } catch (err) {
      const validationError = `Provider response is not valid JSON: ${err instanceof Error ? err.message : String(err)}`;
      attempts.push({
        attempt,
        raw_response_length: text.length,
        raw_response_excerpt: excerpt,
        validation_error: validationError,
        decision: 'retry',
      });
      lastIssues = [{ field: 'response', message: validationError }];
      continue;
    }

    if (!parsed || typeof parsed !== 'object') {
      const validationError = 'Provider response is not a JSON object';
      attempts.push({
        attempt,
        raw_response_length: text.length,
        raw_response_excerpt: excerpt,
        validation_error: validationError,
        decision: 'retry',
      });
      lastIssues = [{ field: 'response', message: validationError }];
      continue;
    }

    const obj = parsed as Record<string, unknown>;

    if (!Array.isArray(obj.tasks) || obj.tasks.length === 0) {
      const validationError = 'Plan must contain a non-empty tasks array';
      attempts.push({
        attempt,
        raw_response_length: text.length,
        raw_response_excerpt: excerpt,
        validation_error: validationError,
        decision: 'retry',
      });
      lastIssues = [{ field: 'tasks', message: validationError }];
      continue;
    }

    let tasks: AutopilotPlanTask[] = [];
    try {
      tasks = obj.tasks.map((t) => validateTask(t, mission.repo_path));
      // Also run the lightweight task-scope validator to capture pattern-level
      // contradictions with rich metadata before the full plan validation pass.
      for (const task of tasks) {
        const scopeIssues = validateTaskScope(task);
        if (scopeIssues.length > 0) {
          const first = scopeIssues[0];
          throw new Error(
            `Task ${task.id} has invalid scope: ${first.message}`
          );
        }
      }
    } catch (err) {
      const validationError = err instanceof Error ? err.message : String(err);
      const conflict = extractConflictPatterns(validationError);
      attempts.push({
        attempt,
        raw_response_length: text.length,
        raw_response_excerpt: excerpt,
        validation_error: validationError,
        conflicting_task_id: extractTaskIdFromField(validationError),
        allowed_pattern: conflict.allowed,
        denied_pattern: conflict.denied,
        decision: 'retry',
      });
      lastIssues = [{ field: 'tasks', message: validationError }];
      continue;
    }

    if (typeof obj.ci_enabled !== 'boolean') {
      const validationError = 'Plan ci_enabled must be boolean';
      attempts.push({
        attempt,
        raw_response_length: text.length,
        raw_response_excerpt: excerpt,
        validation_error: validationError,
        decision: 'retry',
      });
      lastIssues = [{ field: 'ci_enabled', message: validationError }];
      continue;
    }
    if (typeof obj.repair_enabled !== 'boolean') {
      const validationError = 'Plan repair_enabled must be boolean';
      attempts.push({
        attempt,
        raw_response_length: text.length,
        raw_response_excerpt: excerpt,
        validation_error: validationError,
        decision: 'retry',
      });
      lastIssues = [{ field: 'repair_enabled', message: validationError }];
      continue;
    }
    if (!isValidRisk(obj.risk_level)) {
      const validationError = "Plan risk_level must be 'low', 'medium', or 'high'";
      attempts.push({
        attempt,
        raw_response_length: text.length,
        raw_response_excerpt: excerpt,
        validation_error: validationError,
        decision: 'retry',
      });
      lastIssues = [{ field: 'risk_level', message: validationError }];
      continue;
    }
    if (!isStringArray(obj.caveats)) {
      const validationError = 'Plan caveats must be an array of strings';
      attempts.push({
        attempt,
        raw_response_length: text.length,
        raw_response_excerpt: excerpt,
        validation_error: validationError,
        decision: 'retry',
      });
      lastIssues = [{ field: 'caveats', message: validationError }];
      continue;
    }

    const candidatePlan: AutopilotPlanGeneratedPlan = {
      goal: mission.goal,
      mode: mission.mode,
      tasks,
      ci_enabled: obj.ci_enabled,
      repair_enabled: obj.repair_enabled,
      risk_level: obj.risk_level,
      caveats: obj.caveats,
    };

    const planValidation = validateGeneratedPlan(candidatePlan, mission);
    if (!planValidation.ok) {
      const firstIssue = planValidation.issues[0];
      const conflictIssue =
        planValidation.issues.find((i) => i.message.includes('overlap') || i.message.includes('contradictory')) ??
        firstIssue;
      const conflict = extractConflictPatterns(conflictIssue.message);
      attempts.push({
        attempt,
        raw_response_length: text.length,
        raw_response_excerpt: excerpt,
        validation_error: planValidation.issues.map((i) => `${i.field}: ${i.message}`).join('; '),
        conflicting_task_id: extractTaskIdFromField(conflictIssue.field),
        allowed_pattern: conflict.allowed,
        denied_pattern: conflict.denied,
        decision: 'retry',
      });
      lastIssues = planValidation.issues;
      continue;
    }

    attempts.push({
      attempt,
      raw_response_length: text.length,
      raw_response_excerpt: excerpt,
      decision: 'accept',
    });

    return { plan: candidatePlan, attempts };
  }

  throw new ProviderBadOutputError(
    `Failed to generate a valid plan after ${MAX_PLAN_ATTEMPTS} attempts: ${lastIssues.map((i) => `${i.field}: ${i.message}`).join('; ')}`,
    attempts
  );
}

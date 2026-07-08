import type {
  AutopilotPlanGeneratedPlan,
  AutopilotPlanMission,
  AutopilotPlanTask,
} from './types.js';

export class ProviderBadOutputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProviderBadOutputError';
  }
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isString);
}

function isValidRisk(value: unknown): value is 'low' | 'medium' | 'high' {
  return value === 'low' || value === 'medium' || value === 'high';
}

function validateTask(obj: unknown): AutopilotPlanTask {
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
  if (!isValidRisk(raw.risk)) {
    throw new ProviderBadOutputError("Task risk must be 'low', 'medium', or 'high'");
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
    tests: [],
    risk: 'low',
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

export async function generateProviderPlan(
  mission: AutopilotPlanMission,
  providerCallFn: (prompt: string, system?: string) => Promise<unknown>
): Promise<AutopilotPlanGeneratedPlan> {
  const system =
    'You are a safe software planning assistant. Respond with a single JSON object inside a markdown code block. Do not include explanations outside the JSON block.';

  const prompt = [
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
      ? `Allowed files (the AI may only modify these files):\n${mission.allowed_files.map((f) => `- ${f}`).join('\n')}\nReturn tasks with allowed_files exactly equal to this list.`
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
    '      "risk": "low" | "medium" | "high"',
    '    }',
    '  ],',
    '  "ci_enabled": boolean,',
    '  "repair_enabled": boolean,',
    '  "risk_level": "low" | "medium" | "high",',
    '  "caveats": ["string"]',
    '}',
    '',
    'Rules for tests: each entry must be a valid shell command string that can be executed.',
    'For documentation-only changes with no automated verification, use an empty tests array.',
    'Do not put human-readable instructions or sentences into tests.',
    'Generate the smallest number of tasks that achieves the goal.',
    'Do not create separate tasks for commit, push, PR creation, or CI observation; the autopilot runner handles those automatically.',
    'Each task should describe a concrete file or code change, not a git or GitHub operation.',
  ]
    .filter(Boolean)
    .join('\n');

  const rawResponse = await providerCallFn(prompt, system);
  const text = typeof rawResponse === 'string' ? rawResponse : JSON.stringify(rawResponse);
  const jsonText = extractJsonBlock(text);

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch (err) {
    throw new ProviderBadOutputError('Provider response is not valid JSON');
  }

  if (!parsed || typeof parsed !== 'object') {
    throw new ProviderBadOutputError('Provider response is not a JSON object');
  }

  const obj = parsed as Record<string, unknown>;

  if (!Array.isArray(obj.tasks) || obj.tasks.length === 0) {
    throw new ProviderBadOutputError('Plan must contain a non-empty tasks array');
  }

  const tasks = obj.tasks.map(validateTask);

  if (typeof obj.ci_enabled !== 'boolean') {
    throw new ProviderBadOutputError('Plan ci_enabled must be boolean');
  }
  if (typeof obj.repair_enabled !== 'boolean') {
    throw new ProviderBadOutputError('Plan repair_enabled must be boolean');
  }
  if (!isValidRisk(obj.risk_level)) {
    throw new ProviderBadOutputError("Plan risk_level must be 'low', 'medium', or 'high'");
  }
  if (!isStringArray(obj.caveats)) {
    throw new ProviderBadOutputError('Plan caveats must be an array of strings');
  }

  return {
    goal: mission.goal,
    mode: mission.mode,
    tasks,
    ci_enabled: obj.ci_enabled,
    repair_enabled: obj.repair_enabled,
    risk_level: obj.risk_level,
    caveats: obj.caveats,
  };
}

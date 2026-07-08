import { mkdirSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { redactSecrets } from '../diagnose-ci/redaction.js';
import type { MvpRunConfig } from '../mvp-run/types.js';
import type { AutopilotRunConfig } from '../autopilot-run/types.js';
import type {
  AutopilotPlanGeneratedPlan,
  AutopilotPlanMission,
  AutopilotPlanPreflightInfo,
} from './types.js';

export interface AutopilotPlanArtifacts {
  run_dir: string;
  mission_md_path: string;
  mission_json_path: string;
  plan_md_path: string;
  plan_json_path: string;
  mvp_config_path: string;
  autopilot_config_path: string;
  operator_command_path: string;
}

export function getPlanRunDir(outputDir: string, runId: string): string {
  return join(outputDir, runId);
}

export function ensureRunDir(runDir: string): void {
  mkdirSync(runDir, { recursive: true });
}

export function buildMvpRunConfig(
  mission: AutopilotPlanMission,
  plan: AutopilotPlanGeneratedPlan,
  runDir: string
): MvpRunConfig {
  const provider = mission.mode === 'fake' || !mission.capabilities.allow_real_provider ? 'fake' : 'kimi';

  return {
    provider,
    repo_path: mission.repo_path,
    repo_slug: mission.repo_slug,
    base_branch: mission.base_branch,
    work_branch: `mission-${mission.run_id}`,
    run_id: mission.run_id,
    allow_real_provider: mission.capabilities.allow_real_provider,
    allow_real_repo_apply: mission.capabilities.allow_repo_apply,
    allow_real_repo_commit: mission.capabilities.allow_repo_commit,
    allow_real_repo_push: mission.capabilities.allow_repo_push,
    allow_github_pr_create: mission.capabilities.allow_pr_create,
    tasks: plan.tasks.map((task) => ({
      id: task.id,
      title: task.title,
      goal: task.goal,
      allowed_files: task.allowed_files,
      denied_files: task.denied_files ?? ['.env', 'node_modules/**'],
      tests: task.tests ?? [],
    })),
    report_dir: join(runDir, 'mvp-run-reports'),
    on_blocked_task: 'continue',
  };
}

export function buildAutopilotRunConfig(
  mission: AutopilotPlanMission,
  plan: AutopilotPlanGeneratedPlan,
  mvpConfigRelativePath: string
): AutopilotRunConfig {
  const useRealProvider = mission.mode === 'github' && mission.capabilities.allow_real_provider;

  return {
    mode: mission.mode,
    run_id: mission.run_id,
    repo_slug: mission.repo_slug,
    base_branch: mission.base_branch,
    work_branch: `mission-${mission.run_id}`,
    mvp_config_path: mvpConfigRelativePath,
    diagnose_config: {
      token_env: mission.github?.token_env ?? 'GITHUB_TOKEN',
      include_raw_logs: false,
      max_log_excerpt_chars: 4000,
    },
    ci: {
      enabled: mission.capabilities.allow_actions_read,
      wait_for_ci: mission.ci?.wait_for_ci ?? mission.capabilities.allow_actions_read,
      poll_interval_seconds: mission.ci?.poll_interval_seconds ?? 15,
      timeout_seconds: mission.ci?.timeout_seconds ?? 900,
    },
    repair: {
      enabled: plan.repair_enabled && mission.capabilities.allow_repair,
      max_attempts: mission.repair?.max_attempts ?? 1,
      provider: useRealProvider ? 'kimi' : 'mock',
      allow_real_provider: useRealProvider,
      allow_apply: mission.capabilities.allow_repo_apply,
      allow_commit: mission.capabilities.allow_repo_commit,
      allow_push: mission.capabilities.allow_repo_push,
      denied_files: ['.env', 'node_modules/**', 'tmp/**', 'reports/**'],
    },
    github: {
      allow_pr_create: mission.capabilities.allow_pr_create,
      allow_pr_update: mission.capabilities.allow_pr_update,
      allow_actions_read: mission.capabilities.allow_actions_read,
      allow_write: false,
    },
    report_dir: join(mission.output_dir, mission.run_id),
  };
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value, null, 2), 'utf-8');
}

function writeText(path: string, content: string): void {
  writeFileSync(path, redactSecrets(content), 'utf-8');
}

export function writePlanArtifacts(
  runDir: string,
  mission: AutopilotPlanMission,
  plan: AutopilotPlanGeneratedPlan,
  preflight: AutopilotPlanPreflightInfo,
  command: string
): AutopilotPlanArtifacts {
  ensureRunDir(runDir);

  const artifacts: AutopilotPlanArtifacts = {
    run_dir: runDir,
    mission_md_path: join(runDir, 'mission.md'),
    mission_json_path: join(runDir, 'mission.json'),
    plan_md_path: join(runDir, 'plan.md'),
    plan_json_path: join(runDir, 'plan.json'),
    mvp_config_path: join(runDir, 'mvp-run.config.json'),
    autopilot_config_path: join(runDir, 'autopilot.config.json'),
    operator_command_path: join(runDir, 'operator-command.md'),
  };

  writeJson(artifacts.mission_json_path, mission);
  writeJson(artifacts.plan_json_path, { ...plan, preflight });

  const autopilotConfigRelative = relative(process.cwd(), artifacts.autopilot_config_path).replace(/\\/g, '/');
  const mvpConfigRelative = relative(process.cwd(), artifacts.mvp_config_path).replace(/\\/g, '/');

  const mvpConfig = buildMvpRunConfig(mission, plan, runDir);
  const autopilotConfig = buildAutopilotRunConfig(mission, plan, mvpConfigRelative);

  writeJson(artifacts.mvp_config_path, mvpConfig);
  writeJson(artifacts.autopilot_config_path, autopilotConfig);

  const missionMd = [
    `# Mission: ${mission.run_id}`,
    '',
    `- **Repo:** ${mission.repo_slug}`,
    `- **Goal:** ${mission.goal}`,
    `- **Mode:** ${mission.mode}`,
    `- **Base branch:** ${mission.base_branch}`,
    `- **Work branch:** mission-${mission.run_id}`,
    '',
    '## Constraints',
    '',
    mission.constraints && mission.constraints.length > 0
      ? mission.constraints.map((c) => `- ${c}`).join('\n')
      : '- None',
    '',
    '## Capabilities',
    '',
    preflight.capabilities.requested.map((c) => `- ${c}`).join('\n'),
    '',
    '## Tokens',
    '',
    `- Provider token present: ${preflight.provider_token_present ? 'yes' : 'no'}`,
    `- GitHub token present: ${preflight.github_token_present ? 'yes' : 'no'}`,
    '',
    '---',
    `Command: \`${command}\``,
  ].join('\n');

  const planMd = [
    `# Plan: ${mission.run_id}`,
    '',
    `- **Goal:** ${plan.goal}`,
    `- **Mode:** ${plan.mode}`,
    `- **Risk level:** ${plan.risk_level}`,
    `- **CI observation:** ${plan.ci_enabled ? 'enabled' : 'disabled'}`,
    `- **Repair loop:** ${plan.repair_enabled ? 'enabled' : 'disabled'}`,
    '',
    '## Tasks',
    '',
    ...plan.tasks.map((task) => [
      `### ${task.id}: ${task.title}`,
      '',
      `- **Goal:** ${task.goal}`,
      `- **Allowed files:** ${task.allowed_files.join(', ')}`,
      `- **Risk:** ${task.risk}`,
      task.denied_files && task.denied_files.length > 0
        ? `- **Denied files:** ${task.denied_files.join(', ')}`
        : '',
      task.tests && task.tests.length > 0 ? `- **Checks:** ${task.tests.join(', ')}` : '',
      '',
    ].join('\n')),
    '',
    '## Caveats',
    '',
    plan.caveats.length > 0 ? plan.caveats.map((c) => `- ${c}`).join('\n') : '- None',
    '',
    '## Generated configs',
    '',
    `- MVP run config: \`${mvpConfigRelative}\``,
    `- Autopilot config: \`${autopilotConfigRelative}\``,
  ].join('\n');

  const operatorCommand = [
    '# Operator command',
    '',
    'Run the generated autopilot config with:',
    '',
    '```bash',
    `npx tsx src/cli.ts autopilot-run ${autopilotConfigRelative}`,
    '```',
    '',
    'Or use the package script equivalent.',
  ].join('\n');

  writeText(artifacts.mission_md_path, missionMd);
  writeText(artifacts.plan_md_path, planMd);
  writeText(artifacts.operator_command_path, operatorCommand);

  return artifacts;
}

import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import process from 'node:process';
import { loadMissionConfig, validateMissionConfig } from './config-loader.js';
import { runAutopilotPlan } from './runner.js';
import type { AutopilotPlanMission, AutopilotPlanResult } from './types.js';

export { loadMissionConfig, validateMissionConfig, runAutopilotPlan };
export type { AutopilotPlanMission, AutopilotPlanResult };

function printSummary(result: AutopilotPlanResult, configPath: string): void {
  console.error('[autopilot-plan] AUTOPILOT PLAN');
  console.error(`  Run id: ${result.mission.run_id}`);
  console.error(`  Goal: ${result.mission.goal}`);
  console.error(`  Mode: ${result.mission.mode}`);
  console.error(`  Tasks: ${result.plan.tasks.length}`);
  console.error(`  Generated autopilot config: ${result.generated_files.find((p) => p.endsWith('autopilot.config.json')) ?? 'n/a'}`);
  console.error(`  Next command: ${result.next_command || 'n/a'}`);
  console.error(`  Verdict: ${result.verdict}`);
  if (result.reason) {
    console.error(`  Reason: ${result.reason}`);
  }
}

export async function main(args: string[] = process.argv.slice(2)): Promise<void> {
  const input = args[0];

  if (!input) {
    console.error('[autopilot-plan] Error: mission config path or goal text is required');
    console.error('[autopilot-plan] Usage: npx tsx src/cli.ts autopilot-plan <mission.json>');
    console.error('[autopilot-plan]        npx tsx src/cli.ts autopilot-plan "goal text"');
    process.exitCode = 1;
    return;
  }

  let mission: AutopilotPlanMission;
  let configPath: string;

  try {
    if (input.endsWith('.json')) {
      configPath = resolve(input);
      mission = loadMissionConfig(configPath);
    } else {
      // Inline goal: create a safe fake mission on the fly.
      const runId = `inline-${Date.now()}`;
      mission = validateMissionConfig({
        run_id: runId,
        repo_slug: 'local/repo',
        repo_path: '.',
        base_branch: 'main',
        goal: input,
        mode: 'fake',
        capabilities: {
          allow_real_provider: false,
          allow_repo_apply: false,
          allow_repo_commit: false,
          allow_repo_push: false,
          allow_pr_create: false,
          allow_pr_update: false,
          allow_actions_read: false,
          allow_repair: false,
        },
        output_dir: 'reports/autopilot-plans',
      });
      configPath = '<inline-goal>';
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[autopilot-plan] Error: ${message}`);
    process.exitCode = 1;
    return;
  }

  const command = input.endsWith('.json')
    ? `npx tsx src/cli.ts autopilot-plan ${configPath}`
    : `npx tsx src/cli.ts autopilot-plan "${input}"`;

  const result = await runAutopilotPlan(mission, { command });

  printSummary(result, configPath);

  if (result.generated_files.length > 0) {
    console.error('[autopilot-plan] Generated files:');
    for (const file of result.generated_files) {
      console.error(`  - ${file}`);
    }
  }

  process.exitCode = result.exit_code;
}

if (import.meta.url.startsWith('file:') && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await main();
}

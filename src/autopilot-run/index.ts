#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { loadAutopilotRunConfig, validateAutopilotRunConfig } from './config-loader.js';
import { validateAutopilotEnv, buildCapabilitySummary } from './env-validator.js';
import { runAutopilotRun } from './runner.js';
import type { AutopilotRunConfig, AutopilotRunOptions, AutopilotRunResult } from './types.js';

export { loadAutopilotRunConfig, validateAutopilotRunConfig } from './config-loader.js';
export { validateAutopilotEnv, buildCapabilitySummary } from './env-validator.js';
export { runAutopilotRun, runAutopilotRemoteFinalization, type RunAutopilotRunInternalOptions, type RunAutopilotRemoteFinalizationOptions, type AutopilotRemoteFinalizationResult } from './runner.js';
export {
  writeAutopilotReports,
  getAutopilotReportDir,
} from './report-writer.js';
export {
  createTimeline,
  addTimelineEvent,
  writeTimeline,
} from './timeline-writer.js';
export type {
  AutopilotRunConfig,
  AutopilotRunCiConfig,
  AutopilotRunDiagnoseConfig,
  AutopilotRunGithubConfig,
  AutopilotRunRepairConfig,
  AutopilotRunOptions,
  AutopilotRunResult,
  AutopilotRunTimelineEvent,
  AutopilotRunVerdict,
  AutopilotCapabilitySummary,
  AutopilotRepairProvider,
} from './types.js';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const configPath = args[0];

  if (!configPath) {
    console.error('[autopilot-run] Error: config JSON path is required');
    console.error('[autopilot-run] Usage: npx tsx src/autopilot-run/index.ts <config.json>');
    console.error('[autopilot-run] No provider call was made');
    console.error('[autopilot-run] No repository mutation was performed');
    console.error('[autopilot-run] No merge was performed');
    process.exitCode = 1;
    return;
  }

  try {
    const config = loadAutopilotRunConfig(configPath);
    const result = await runAutopilotRun(config, configPath, {
      command: `npx tsx src/autopilot-run/index.ts ${configPath}`,
    });

    console.error(`[autopilot-run] ${result.verdict}`);
    console.error(`[autopilot-run] Report: ${result.report_dir}`);
    if (result.next_human_action) {
      console.error(`[autopilot-run] Next: ${result.next_human_action}`);
    }

    process.exitCode = result.exit_code;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[autopilot-run] Error: ${message}`);
    console.error('[autopilot-run] No provider call was made');
    console.error('[autopilot-run] No repository mutation was performed');
    console.error('[autopilot-run] No merge was performed');
    process.exitCode = 1;
  }
}

// Only run CLI main when executed directly, not when imported as a module.
if (import.meta.url.startsWith('file:') && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await main();
}

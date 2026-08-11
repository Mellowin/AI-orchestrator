import { pathToFileURL } from 'node:url';
import process from 'node:process';
import { runAutopilotOneClick } from './runner.js';
import type { AutopilotOneClickOptions, AutopilotOneClickPreset } from './types.js';

export { runAutopilotOneClick };
export type { AutopilotOneClickOptions, AutopilotOneClickResult } from './types.js';

function isValidPreset(value: string): value is AutopilotOneClickPreset {
  return ['safe', 'read-ci', 'real-pr', 'real-repair', 'real-multitask', 'multitask-safe'].includes(value);
}

function parseArgs(rawArgs: string[]): { input: string; options: AutopilotOneClickOptions } {
  const options: AutopilotOneClickOptions = {};
  const positional: string[] = [];

  for (let i = 0; i < rawArgs.length; i += 1) {
    const arg = rawArgs[i];
    const next = rawArgs[i + 1];

    if (arg === '--mode') {
      if (!next || (!next.startsWith('fake') && !next.startsWith('github'))) {
        throw new Error('--mode requires fake or github');
      }
      options.mode = next as 'fake' | 'github';
      i += 1;
    } else if (arg === '--preset') {
      if (!next || !isValidPreset(next)) {
        throw new Error('--preset requires safe, read-ci, real-pr, real-repair, real-multitask, or multitask-safe');
      }
      options.preset = next;
      i += 1;
    } else if (arg === '--run-id') {
      if (!next) throw new Error('--run-id requires a value');
      options.run_id = next;
      i += 1;
    } else if (arg === '--repo') {
      if (!next) throw new Error('--repo requires a value');
      options.repo = next;
      i += 1;
    } else if (arg === '--repo-slug') {
      if (!next) throw new Error('--repo-slug requires a value');
      options.repo_slug = next;
      i += 1;
    } else if (arg === '--repo-path') {
      if (!next) throw new Error('--repo-path requires a value');
      options.repo_path = next;
      i += 1;
    } else if (arg === '--base-branch') {
      if (!next) throw new Error('--base-branch requires a value');
      options.base_branch = next;
      i += 1;
    } else if (arg === '--output-dir') {
      if (!next) throw new Error('--output-dir requires a value');
      options.output_dir = next;
      i += 1;
    } else if (arg === '--allowed-files') {
      if (!next) throw new Error('--allowed-files requires a value');
      if (!options.allowed_files) {
        options.allowed_files = [];
      }
      options.allowed_files.push(next);
      i += 1;
    } else if (arg === '--yes') {
      options.yes = true;
    } else if (arg === '--resume') {
      options.resume = true;
    } else if (arg.startsWith('--')) {
      throw new Error(`Unknown option: ${arg}`);
    } else {
      positional.push(arg);
    }
  }

  if (positional.length === 0) {
    throw new Error('Mission config path or raw goal is required');
  }

  const input = positional.join(' ');
  return { input, options };
}

function printCapabilitySummary(): void {
  console.error('[autopilot-one-click] Hard safety rules:');
  console.error('  Forbidden:');
  console.error('    - github.merge');
  console.error('    - git.force_push');
  console.error('    - github.actions.rerun');
  console.error('    - repo.delete_branch');
}

export async function main(rawArgs: string[] = process.argv.slice(2)): Promise<void> {
  if (rawArgs.length === 0) {
    console.error('[autopilot-one-click] Error: mission config path or raw goal is required');
    console.error('[autopilot-one-click] Usage: npx tsx src/cli.ts autopilot-one-click <mission.json>');
    console.error('                                     autopilot-one-click "goal text" [--repo owner/repo|URL|local-path] [--preset safe|read-ci|real-pr|real-repair|real-multitask|multitask-safe] [--resume]');
    process.exitCode = 1;
    return;
  }

  let input: string;
  let options: AutopilotOneClickOptions;
  try {
    ({ input, options } = parseArgs(rawArgs));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[autopilot-one-click] Error: ${message}`);
    process.exitCode = 1;
    return;
  }

  printCapabilitySummary();

  const command = `npx tsx src/cli.ts autopilot-one-click ${rawArgs.join(' ')}`;
  const result = await runAutopilotOneClick(input, options, command);

  console.error('[autopilot-one-click] ONE-CLICK AUTOPILOT');
  console.error(`[autopilot-one-click] Goal: ${result.raw_goal ?? result.mission.goal}`);
  console.error(`[autopilot-one-click] Run id: ${result.mission.run_id}`);
  console.error(`[autopilot-one-click] Mode: ${result.mission.mode}`);
  console.error(`[autopilot-one-click] Preset: ${options.preset ?? (result.mission.mode === 'fake' ? 'safe' : 'custom')}`);
  console.error(`[autopilot-one-click] Plan: ${result.plan_result.verdict}`);
  console.error(`[autopilot-one-click] Autopilot: ${result.autopilot_result?.verdict ?? 'n/a'}`);
  console.error(`[autopilot-one-click] Final verdict: ${result.verdict}`);
  console.error(`[autopilot-one-click] Reports: ${result.run_dir}`);
  if (result.next_human_action) {
    console.error(`[autopilot-one-click] Next: ${result.next_human_action}`);
  }

  process.exitCode = result.exit_code;
}

if (import.meta.url.startsWith('file:') && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await main();
}

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createAIClient } from '../ai-client-factory.js';
import { config as aiConfig } from '../config.js';
import type { AIClient } from '../ai-client.js';
import {
  buildCapabilitySummary,
  checkTokenPresence,
  deriveCaveats,
} from './env-validator.js';
import { generateFakePlan, generateProviderPlan, ProviderBadOutputError, type PlannerAttempt } from './plan-generator.js';
import { getPlanRunDir, writePlanArtifacts } from './report-writer.js';
import type {
  AutopilotPlanGeneratedPlan,
  AutopilotPlanMission,
  AutopilotPlanPreflightInfo,
  AutopilotPlanResult,
  AutopilotPlanVerdict,
  RunAutopilotPlanOptions,
} from './types.js';

function buildFailureResult(
  mission: AutopilotPlanMission,
  verdict: AutopilotPlanVerdict,
  reason: string,
  command: string,
  exitCode: number
): AutopilotPlanResult {
  const capabilities = buildCapabilitySummary(mission.capabilities);
  const tokens = checkTokenPresence(mission);
  return {
    mission,
    plan: {
      goal: mission.goal,
      mode: mission.mode,
      tasks: [],
      ci_enabled: false,
      repair_enabled: false,
      risk_level: 'low',
      caveats: [],
    },
    preflight: {
      run_id: mission.run_id,
      repo: mission.repo_slug,
      goal: mission.goal,
      mode: mission.mode,
      output_dir: mission.output_dir,
      capabilities,
      provider_token_present: tokens.provider_token_present,
      github_token_present: tokens.github_token_present,
      caveats: deriveCaveats(mission, tokens),
    },
    run_dir: getPlanRunDir(mission.output_dir, mission.run_id),
    generated_files: [],
    verdict,
    reason,
    exit_code: exitCode,
    next_command: '',
  };
}

function defaultProviderCallFn(): (prompt: string, system?: string) => Promise<unknown> {
  let client: AIClient | null = null;
  return async (prompt: string, system?: string) => {
    if (!client) {
      client = createAIClient({
        provider: aiConfig.ai.provider === 'kimi' ? 'kimi' : 'mock',
        mockResponse: aiConfig.ai.provider === 'mock' ? '{"tasks":[]}' : undefined,
        kimi:
          aiConfig.ai.provider === 'kimi'
            ? {
                apiKey: aiConfig.ai.kimiApiKey,
                model: aiConfig.ai.kimiModel,
                baseUrl: aiConfig.ai.kimiBaseUrl,
                userAgent: aiConfig.ai.kimiUserAgent || undefined,
              }
            : undefined,
      });
    }
    const fullPrompt = system ? `${system}\n\n${prompt}` : prompt;
    return client.generate(fullPrompt);
  };
}

export async function runAutopilotPlan(
  mission: AutopilotPlanMission,
  options: RunAutopilotPlanOptions = {}
): Promise<AutopilotPlanResult> {
  const command = options.command ?? `npx tsx src/cli.ts autopilot-plan <mission>`;
  const startedAt = new Date().toISOString();

  try {
    const capabilities = buildCapabilitySummary(mission.capabilities);
    const tokens = checkTokenPresence(mission);
    const caveats = deriveCaveats(mission, tokens);

    if (tokens.needed_provider && !tokens.provider_token_present) {
      return buildFailureResult(
        mission,
        'AUTOPILOT_PLAN_NEEDS_PROVIDER_TOKEN',
        `Provider token (${mission.provider?.token_env ?? 'KIMI_API_KEY'}) is required in real mode`,
        command,
        1
      );
    }

    const runDir = getPlanRunDir(mission.output_dir, mission.run_id);

    if (mission.mode === 'github' && mission.capabilities.allow_real_provider) {
      // Ensure repo_path exists for real provider mode; fake mode can tolerate non-existent paths.
      const resolvedRepo = resolve(mission.repo_path);
      if (!existsSync(resolvedRepo)) {
        return buildFailureResult(
          mission,
          'AUTOPILOT_PLAN_CONFIG_ERROR',
          `repo_path does not exist: ${mission.repo_path}`,
          command,
          1
        );
      }
    }

    let plan: AutopilotPlanGeneratedPlan;
    let plannerAttempts: PlannerAttempt[] = [];
    try {
      if (mission.mode === 'fake' || !mission.capabilities.allow_real_provider) {
        plan = generateFakePlan(mission);
      } else {
        const providerCall = options.providerCallFn ?? defaultProviderCallFn();
        const generated = await generateProviderPlan(mission, providerCall);
        plan = generated.plan;
        plannerAttempts = generated.attempts;
      }
    } catch (err) {
      if (err instanceof ProviderBadOutputError) {
        if (err.attempts && err.attempts.length > 0) {
          try {
            mkdirSync(runDir, { recursive: true });
            writeFileSync(
              join(runDir, 'plan-provider-attempts.json'),
              JSON.stringify(err.attempts, null, 2),
              'utf-8'
            );
          } catch {
            // Best-effort evidence capture; do not mask the original failure.
          }
        }
        return buildFailureResult(
          mission,
          'AUTOPILOT_PLAN_PROVIDER_BAD_OUTPUT',
          err.message,
          command,
          1
        );
      }
      throw err;
    }

    // Enforce safety ceiling: fake mode cannot enable CI/repair regardless of provider plan.
    if (mission.mode === 'fake') {
      plan.ci_enabled = false;
      plan.repair_enabled = false;
    }

    const preflight: AutopilotPlanPreflightInfo = {
      run_id: mission.run_id,
      repo: mission.repo_slug,
      goal: mission.goal,
      mode: mission.mode,
      output_dir: mission.output_dir,
      capabilities,
      provider_token_present: tokens.provider_token_present,
      github_token_present: tokens.github_token_present,
      caveats,
    };

    const artifacts = writePlanArtifacts(runDir, mission, plan, preflight, command);

    const verdict: AutopilotPlanVerdict =
      caveats.length > 0 && !caveats.some((c) => c.includes('Provider token') || c.includes('GitHub token'))
        ? 'AUTOPILOT_PLAN_READY_WITH_CAVEATS'
        : 'AUTOPILOT_PLAN_READY';

    return {
      mission,
      plan,
      preflight,
      run_dir: runDir,
      generated_files: Object.values(artifacts),
      verdict,
      reason: 'Plan generated successfully',
      exit_code: 0,
      next_command: `npx tsx src/cli.ts autopilot-run ${artifacts.autopilot_config_path}`,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return buildFailureResult(
      mission,
      'AUTOPILOT_PLAN_FAILED',
      message,
      command,
      1
    );
  }
}

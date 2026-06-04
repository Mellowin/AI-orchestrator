import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type {
  BlockDefinition,
  BlockState,
  BlockTaskDefinition,
  BlockProviderRoleConfig,
} from './block-types.js';
import type {
  CoderTaskInput,
  ProviderConfig,
  CoderProvider,
  ReviewerProvider,
} from '../providers/provider-types.js';
import type { OneTaskLoopMode } from './block-runner-types.js';
import { createFakeCoderProvider, type FakeCoderOptions } from '../providers/fake/fake-coder-provider.js';
import { createFakeReviewerProvider, type FakeReviewerOptions } from '../providers/fake/fake-reviewer-provider.js';
import { createKimiCoderProvider } from '../providers/kimi/kimi-coder-provider.js';
import { createKimiReviewerProvider, type KimiReviewerProviderOptions } from '../providers/kimi/kimi-reviewer-provider.js';
import type { Guardrails, Check } from '../types.js';

const PRODUCT_VISION_PATH = resolve(process.cwd(), 'prompts', 'product-vision-for-kimi.md');

export function getCurrentBlockTaskDefinition(
  blockDefinition: BlockDefinition,
  blockState: BlockState
): BlockTaskDefinition {
  if (!blockState.current_task_id) {
    throw new Error('No current task id in block state');
  }
  const task = blockDefinition.tasks.find((t) => t.task_id === blockState.current_task_id);
  if (!task) {
    throw new Error(`Current task ${blockState.current_task_id} not found in block definition`);
  }
  return task;
}

function loadProductVisionContext(): string {
  if (!existsSync(PRODUCT_VISION_PATH)) {
    return '';
  }
  try {
    return readFileSync(PRODUCT_VISION_PATH, 'utf-8');
  } catch {
    return '';
  }
}

export function buildCoderInputFromBlockTask(
  _blockDefinition: BlockDefinition,
  taskDefinition: BlockTaskDefinition,
  _blockState: BlockState
): CoderTaskInput {
  const productVision = loadProductVisionContext();
  const repoContext = productVision
    ? `# Product Vision Context\n\n${productVision}\n\n# Task Goal\n${taskDefinition.goal}`
    : taskDefinition.goal;

  return {
    task_id: taskDefinition.task_id,
    title: taskDefinition.title,
    goal: taskDefinition.goal,
    allowed_files: [...taskDefinition.allowed_files],
    denied_files: [...taskDefinition.denied_files],
    max_lines_changed: taskDefinition.max_lines_changed,
    repo_context: repoContext,
  };
}

export function buildTaskGuardrailsFromBlockTask(taskDefinition: BlockTaskDefinition): Guardrails {
  return {
    allow_modify: [...taskDefinition.allowed_files],
    deny_modify: [...taskDefinition.denied_files],
    max_lines_changed: taskDefinition.max_lines_changed,
    auto_commit: false,
    auto_push: false,
    auto_merge: false,
  };
}

export function convertBlockChecks(checks: string[]): Check[] {
  return checks.map((c) => {
    const trimmed = c.trim();
    if (!trimmed) {
      return { command: '', args: [] };
    }
    const parts = trimmed.split(/\s+/);
    return { command: parts[0], args: parts.slice(1) };
  });
}

export function buildProviderConfigForRuntime(
  blockConfig: BlockProviderRoleConfig,
  role: 'coder' | 'reviewer',
  env: NodeJS.ProcessEnv = process.env
): ProviderConfig {
  const config: ProviderConfig = {
    provider: blockConfig.provider as import('../providers/provider-types.js').ProviderId,
    model: blockConfig.model,
  };

  if (blockConfig.baseUrl) {
    config.baseUrl = blockConfig.baseUrl;
  }
  if (blockConfig.userAgent) {
    config.userAgent = blockConfig.userAgent;
  }

  if (blockConfig.provider === 'kimi') {
    const apiKey = env.KIMI_API_KEY?.trim();
    if (!apiKey) {
      throw new Error('KIMI_API_KEY is required for real Kimi provider');
    }
    config.apiKey = apiKey;

    if (!config.baseUrl && env.KIMI_BASE_URL) {
      config.baseUrl = env.KIMI_BASE_URL.trim();
    }
    if (!config.userAgent && env.KIMI_USER_AGENT) {
      config.userAgent = env.KIMI_USER_AGENT.trim();
    }
  }

  return config;
}

export interface ResolveProvidersInput {
  mode: OneTaskLoopMode;
  coderBlockConfig: BlockProviderRoleConfig;
  reviewerBlockConfig: BlockProviderRoleConfig;
  allowRealProvider: boolean;
  allowKimiReviewer: boolean;
  fakeCoderOptions?: FakeCoderOptions;
  fakeReviewerOptions?: FakeReviewerOptions;
  kimiReviewerOptions?: KimiReviewerProviderOptions;
  env?: NodeJS.ProcessEnv;
}

export function resolveCoderAndReviewerProviders(
  input: ResolveProvidersInput
): { coder: CoderProvider; reviewer: ReviewerProvider } {
  switch (input.mode) {
    case 'fake': {
      return {
        coder: createFakeCoderProvider(input.fakeCoderOptions),
        reviewer: createFakeReviewerProvider(input.fakeReviewerOptions),
      };
    }
    case 'real_kimi_coder_fake_reviewer': {
      if (!input.allowRealProvider) {
        throw new Error('Mode real_kimi_coder_fake_reviewer requires ALLOW_REAL_PROVIDER=true');
      }
      const coderConfig = buildProviderConfigForRuntime(input.coderBlockConfig, 'coder', input.env);
      return {
        coder: createKimiCoderProvider(coderConfig),
        reviewer: createFakeReviewerProvider(input.fakeReviewerOptions),
      };
    }
    case 'real_kimi_coder_kimi_reviewer': {
      if (!input.allowRealProvider) {
        throw new Error('Mode real_kimi_coder_kimi_reviewer requires ALLOW_REAL_PROVIDER=true');
      }
      if (!input.allowKimiReviewer) {
        throw new Error('Mode real_kimi_coder_kimi_reviewer requires ALLOW_KIMI_REVIEWER=true');
      }
      const coderConfig = buildProviderConfigForRuntime(input.coderBlockConfig, 'coder', input.env);
      const reviewerConfig = buildProviderConfigForRuntime(input.reviewerBlockConfig, 'reviewer', input.env);
      return {
        coder: createKimiCoderProvider(coderConfig),
        reviewer: createKimiReviewerProvider(reviewerConfig, input.kimiReviewerOptions),
      };
    }
    default: {
      throw new Error(`Unknown one-task loop mode: ${input.mode}`);
    }
  }
}

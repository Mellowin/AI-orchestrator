import type {
  AcceptanceScenarioConfig,
  FailureClassification,
  ScenarioStatus,
} from './types.js';

export interface ScenarioClassification {
  status: ScenarioStatus;
  classification?: FailureClassification;
  reason: string;
  expected: boolean;
}

interface BlockSummary {
  status: string | null;
  totalTasks: number;
  completedTasks: number;
  acceptedTasks: number;
  fixedTasks: number;
  skippedBlockedTasks: number;
  stoppedReason: string | null;
  blockedTaskId?: string | null;
}

function getBlockSummary(state: Record<string, unknown> | null): BlockSummary {
  const summary = (state?.summary as Record<string, unknown>) ?? {};
  return {
    status: typeof state?.status === 'string' ? state.status : null,
    totalTasks: typeof summary.totalTasks === 'number' ? summary.totalTasks : 0,
    completedTasks: typeof summary.completedTasks === 'number' ? summary.completedTasks : 0,
    acceptedTasks: typeof summary.acceptedTasks === 'number' ? summary.acceptedTasks : 0,
    fixedTasks: typeof summary.fixedTasks === 'number' ? summary.fixedTasks : 0,
    skippedBlockedTasks: typeof summary.skippedBlockedTasks === 'number' ? summary.skippedBlockedTasks : 0,
    stoppedReason: typeof summary.stoppedReason === 'string' ? summary.stoppedReason : null,
    blockedTaskId: typeof summary.blockedTaskId === 'string' ? summary.blockedTaskId : null,
  };
}

export function classifyScenarioResult(
  scenario: AcceptanceScenarioConfig,
  exitCode: number,
  state: Record<string, unknown> | null
): ScenarioClassification {
  const summary = getBlockSummary(state);

  if (!state) {
    return {
      status: 'failed',
      classification: 'ORCHESTRATOR_BUG',
      reason: `Block runner exited ${exitCode} and no state was persisted`,
      expected: false,
    };
  }

  if (scenario.type === 'blocked_stop') {
    const blockedBySafety =
      summary.status === 'blocked' && summary.blockedTaskId === 'unsafe_block';
    if (blockedBySafety) {
      return {
        status: 'passed',
        classification:
          scenario.unsafe_response_mode === 'fake_deterministic'
            ? 'SAFETY_POLICY_BLOCK_EXPECTED_WITH_FAKE_UNSAFE_RESPONSE'
            : 'SAFETY_POLICY_BLOCK_EXPECTED',
        reason: 'Unsafe task was blocked at safety policy as expected',
        expected: true,
      };
    }
    return {
      status: 'failed',
      classification: 'ORCHESTRATOR_BUG',
      reason: `Expected blocked_stop but block status is ${summary.status}`,
      expected: false,
    };
  }

  if (scenario.type === 'blocked_continue') {
    const skipped = summary.skippedBlockedTasks > 0;
    const completed =
      summary.status === 'completed_with_caveats' ||
      (summary.status === 'completed' && skipped);
    if (completed && skipped) {
      return {
        status: 'passed',
        classification:
          scenario.unsafe_response_mode === 'fake_deterministic'
            ? 'SAFETY_POLICY_BLOCK_EXPECTED_WITH_FAKE_UNSAFE_RESPONSE'
            : 'SAFETY_POLICY_BLOCK_EXPECTED',
        reason: `Unsafe task skipped; ${summary.completedTasks}/${summary.totalTasks} tasks completed`,
        expected: true,
      };
    }
    return {
      status: 'failed',
      classification: 'ORCHESTRATOR_BUG',
      reason: `Expected blocked_continue (completed_with_caveats + skipped>0) but got status=${summary.status}, skipped=${summary.skippedBlockedTasks}`,
      expected: false,
    };
  }

  if (scenario.type === 'golden_real_multitask') {
    if (summary.status === 'completed') {
      return {
        status: 'passed',
        reason: `All ${summary.totalTasks} tasks completed`,
        expected: true,
      };
    }
    if (summary.status === 'completed_with_caveats') {
      return {
        status: 'passed_with_caveats',
        classification: 'UNKNOWN',
        reason: `Block completed with caveats: ${summary.stoppedReason ?? 'unknown'}`,
        expected: false,
      };
    }
    if (summary.status === 'blocked') {
      return {
        status: 'failed',
        classification: 'SAFETY_POLICY_BLOCK_EXPECTED',
        reason: `Golden multi-task scenario was unexpectedly blocked: ${summary.stoppedReason ?? 'unknown'}`,
        expected: false,
      };
    }
    return {
      status: 'failed',
      classification: 'ORCHESTRATOR_BUG',
      reason: `Expected completed but block status is ${summary.status}`,
      expected: false,
    };
  }

  return {
    status: 'failed',
    classification: 'UNKNOWN',
    reason: `Unrecognized scenario type: ${scenario.type}`,
    expected: false,
  };
}

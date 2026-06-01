export type AgentPlanStatus = 'planned';
export type AgentPlanMode = 'dry-run';

export interface AgentPlan {
  taskId: string;
  status: AgentPlanStatus;
  mode: AgentPlanMode;
  steps: string[];
  actionsExecuted: false;
  message: string;
}

export function buildAgentPlan(taskId: string, mode: AgentPlanMode = 'dry-run'): AgentPlan {
  return {
    taskId,
    status: 'planned',
    mode,
    steps: [
      'ai-run',
      'ai-output-status',
      'ai-apply',
      'checks',
      'commit',
      'review',
    ],
    actionsExecuted: false,
    message: 'No actions executed yet.',
  };
}

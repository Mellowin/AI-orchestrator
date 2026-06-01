export type AgentPlanStatus = 'planned';

export interface AgentPlan {
  taskId: string;
  status: AgentPlanStatus;
  steps: string[];
  actionsExecuted: false;
  message: string;
}

export function buildAgentPlan(taskId: string): AgentPlan {
  return {
    taskId,
    status: 'planned',
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

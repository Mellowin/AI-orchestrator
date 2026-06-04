import type { BlockState } from './block-types.js';

export function buildBlockStatusReport(state: BlockState): string {
  const currentTask = state.tasks.find((t) => t.task_id === state.current_task_id);

  const acceptedCount = state.tasks.filter((t) => t.status === 'accepted').length;
  const rejectedCount = state.tasks.filter((t) => t.status === 'rejected').length;
  const blockedCount = state.tasks.filter((t) => t.status === 'blocked').length;

  const taskRows = state.tasks
    .map((t) => {
      const commit = t.commit_sha ?? '-';
      const decision = t.reviewer_decision ?? '-';
      return `| ${t.task_id} | ${t.status} | ${t.current_attempt} | ${t.fix_attempts} | ${commit.slice(0, 7)} | ${decision} |`;
    })
    .join('\n');

  const reviewPolicySummary = state.review_policy
    ? `max_fix_attempts=${state.review_policy.max_fix_attempts}, reviewer_mode=${state.review_policy.reviewer_mode}`
    : 'unknown';

  return (
    `# Block Status Report\n\n` +
    `- **Block ID:** ${state.block_id}\n` +
    `- **Title:** ${state.title}\n` +
    `- **Status:** ${state.status}\n` +
    `- **Current Task:** ${currentTask ? currentTask.task_id : 'none'}\n` +
    `- **Updated:** ${state.updated_at}\n` +
    `- **Review Policy:** ${reviewPolicySummary}\n\n` +
    `## Tasks\n\n` +
    `| Task ID | Status | Attempt | Fix Attempts | Commit | Reviewer Decision |\n` +
    `|---|---|---|---|---|---|\n` +
    `${taskRows}\n\n` +
    `## Summary\n\n` +
    `- Accepted: ${acceptedCount}\n` +
    `- Rejected: ${rejectedCount}\n` +
    `- Blocked: ${blockedCount}\n` +
    `- Total: ${state.tasks.length}\n\n` +
    `## Safety Note\n\n` +
    `${state.safety_note}\n`
  );
}

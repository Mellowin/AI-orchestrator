/**
 * Build the resume command for a paused mission.
 *
 * Exact resume identity: every generated resume command MUST pin the original
 * mission run id via --run-id so that a raw-goal resume rebuilds the SAME
 * mission (same run id, report directory, workspace, state) instead of
 * generating a fresh time-based run id. Neither --run-id nor --resume is
 * duplicated when the original command already carries it.
 */
export function buildResumeCommand(command: string, runId: string): string {
  let result = command.trimEnd();
  if (!/(?:^|\s)--run-id(?:\s|=|$)/.test(result)) {
    result = `${result} --run-id ${runId}`;
  }
  if (!/(?:^|\s)--resume(?:\s|$)/.test(result)) {
    result = `${result} --resume`;
  }
  return result;
}

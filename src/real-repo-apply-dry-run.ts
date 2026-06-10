export type RealRepoDryRunFile = {
  path: string;
  lineDelta: number;
  isNew: boolean;
};

export type RealRepoDryRunInput = {
  taskId: string;
  currentBranch: string;
  workBranch: string;
  guardrailsVerdict: 'PASS' | 'REJECTED';
  safetyVerdict: 'PASS' | 'REJECTED';
  files: RealRepoDryRunFile[];
};

export type RealRepoDryRunSummary = {
  taskId: string;
  currentBranch: string;
  workBranch: string;
  guardrailsVerdict: 'PASS' | 'REJECTED';
  safetyVerdict: 'PASS' | 'REJECTED';
  files: RealRepoDryRunFile[];
  safetyMessages: string[];
};

function validateFile(file: RealRepoDryRunFile, index: number): void {
  if (typeof file.path !== 'string') {
    throw new Error(`File at index ${index} has invalid path`);
  }
  if (file.path.trim().length === 0) {
    throw new Error(`File at index ${index} has empty path`);
  }
  if (!Number.isFinite(file.lineDelta)) {
    throw new Error(`File at index ${index} has non-finite lineDelta`);
  }
}

export function buildRealRepoApplyDryRunSummary(
  input: RealRepoDryRunInput
): RealRepoDryRunSummary {
  if (typeof input.taskId !== 'string' || input.taskId.trim().length === 0) {
    throw new Error('taskId must be a non-empty string');
  }
  if (
    typeof input.currentBranch !== 'string' ||
    input.currentBranch.trim().length === 0
  ) {
    throw new Error('currentBranch must be a non-empty string');
  }
  if (
    typeof input.workBranch !== 'string' ||
    input.workBranch.trim().length === 0
  ) {
    throw new Error('workBranch must be a non-empty string');
  }

  const seen = new Set<string>();
  const files: RealRepoDryRunFile[] = [];

  for (let i = 0; i < input.files.length; i++) {
    const file = input.files[i];
    validateFile(file, i);
    const trimmedPath = file.path.trim();
    if (seen.has(trimmedPath)) {
      throw new Error(`Duplicate file path after trimming: ${trimmedPath}`);
    }
    seen.add(trimmedPath);
    files.push({
      path: trimmedPath,
      lineDelta: file.lineDelta,
      isNew: file.isNew,
    });
  }

  return {
    taskId: input.taskId.trim(),
    currentBranch: input.currentBranch.trim(),
    workBranch: input.workBranch.trim(),
    guardrailsVerdict: input.guardrailsVerdict,
    safetyVerdict: input.safetyVerdict,
    files,
    safetyMessages: [
      'No files were modified',
      'No commit was made',
      'No push was performed',
      'No merge was performed',
      'Real repo apply is dry-run only',
    ],
  };
}

export type RealRepoApplyPlanFileInput = {
  path: string;
  content: string;
};

export type RealRepoApplyPlanInput = {
  taskId: string;
  attempt: number;
  existingPaths: string[];
  files: RealRepoApplyPlanFileInput[];
};

export type RealRepoApplyPlannedFile = {
  path: string;
  action: 'create' | 'overwrite';
  backupPath: string;
  content: string;
};

export type RealRepoApplyPlanResult =
  | {
      ok: true;
      taskId: string;
      attempt: number;
      runDir: string;
      files: RealRepoApplyPlannedFile[];
      safetyMessages: string[];
    }
  | {
      ok: false;
      reason: string;
      safetyMessages: string[];
    };

function validatePath(path: string, context: string): string | null {
  if (typeof path !== 'string') {
    return `${context} is not a string`;
  }
  const trimmed = path.trim();
  if (trimmed.length === 0) {
    return `${context} is empty`;
  }
  if (trimmed.startsWith('/')) {
    return `${context} is absolute: ${trimmed}`;
  }
  if (/^[A-Za-z]:\//.test(trimmed)) {
    return `${context} is absolute: ${trimmed}`;
  }
  const parts = trimmed.split('/');
  for (const part of parts) {
    if (part === '..') {
      return `${context} contains path traversal: ${trimmed}`;
    }
  }
  if (trimmed.includes('\\')) {
    return `${context} contains backslash: ${trimmed}`;
  }
  return null;
}

export function buildRealRepoApplyPlan(
  input: RealRepoApplyPlanInput
): RealRepoApplyPlanResult {
  const safetyMessages = [
    'No commit will be made',
    'No push will be performed',
    'No merge will be performed',
    'Main branch will not be touched',
    'Provider will not be called',
  ];

  if (typeof input.taskId !== 'string' || input.taskId.trim().length === 0) {
    return {
      ok: false,
      reason: 'taskId must be a non-empty string',
      safetyMessages,
    };
  }

  if (!Number.isInteger(input.attempt) || input.attempt < 1) {
    return {
      ok: false,
      reason: 'attempt must be a positive integer',
      safetyMessages,
    };
  }

  const taskId = input.taskId.trim();

  const seenExisting = new Set<string>();
  for (let i = 0; i < input.existingPaths.length; i++) {
    const pathErr = validatePath(input.existingPaths[i], `existingPaths[${i}]`);
    if (pathErr) {
      return { ok: false, reason: pathErr, safetyMessages };
    }
    const trimmed = input.existingPaths[i].trim();
    if (seenExisting.has(trimmed)) {
      return {
        ok: false,
        reason: `Duplicate existingPaths after trimming: ${trimmed}`,
        safetyMessages,
      };
    }
    seenExisting.add(trimmed);
  }

  const existingSet = new Set<string>(
    input.existingPaths.map((p) => p.trim())
  );

  const seenFiles = new Set<string>();
  const plannedFiles: RealRepoApplyPlannedFile[] = [];
  const runDir = `runs/${taskId}/attempt-${input.attempt}`;

  for (let i = 0; i < input.files.length; i++) {
    const file = input.files[i];
    const pathErr = validatePath(file.path, `files[${i}].path`);
    if (pathErr) {
      return { ok: false, reason: pathErr, safetyMessages };
    }

    if (typeof file.content !== 'string') {
      return {
        ok: false,
        reason: `files[${i}].content is not a string`,
        safetyMessages,
      };
    }

    const trimmedPath = file.path.trim();
    if (seenFiles.has(trimmedPath)) {
      return {
        ok: false,
        reason: `Duplicate file path after trimming: ${trimmedPath}`,
        safetyMessages,
      };
    }
    seenFiles.add(trimmedPath);

    const action = existingSet.has(trimmedPath) ? 'overwrite' : 'create';
    const backupPath = `${runDir}/files-before/${trimmedPath}`;

    plannedFiles.push({
      path: trimmedPath,
      action,
      backupPath,
      content: file.content,
    });
  }

  return {
    ok: true,
    taskId,
    attempt: input.attempt,
    runDir,
    files: plannedFiles,
    safetyMessages,
  };
}

import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { initAttemptDir } from './state-manager.js';
import type { KimiOutput, PatchManifestEntry, Task } from './types.js';
import type {
  ClassifiedKimiOutput,
  ClassifiedProposedFile,
  KimiOutputClassification,
} from './kimi-output-classifier.js';

export interface ProviderAttemptEvidenceOptions {
  taskId: string;
  attempt: number;
  repoPath: string;
  rawText: string;
  kimiOutput?: KimiOutput;
  classified?: ClassifiedKimiOutput;
  error?: string;
  phase: 'pre-apply' | 'post-apply';
  manifest?: PatchManifestEntry[];
  attemptDir?: string;
}

export function writeProviderAttemptEvidence(options: ProviderAttemptEvidenceOptions): void {
  const {
    taskId,
    attempt,
    repoPath,
    rawText,
    kimiOutput,
    classified,
    error,
    phase,
    manifest,
    attemptDir: explicitAttemptDir,
  } = options;
  const attemptDir = explicitAttemptDir ?? initAttemptDir(taskId, attempt);
  mkdirSync(attemptDir, { recursive: true });

  const rawHash = createHash('sha256').update(rawText, 'utf-8').digest('hex');
  writeFileSync(join(attemptDir, 'provider-raw.txt'), rawText, { encoding: 'utf-8', mode: 0o600 });
  writeFileSync(join(attemptDir, 'provider-raw.sha256'), rawHash, { encoding: 'utf-8', mode: 0o600 });

  if (error !== undefined) {
    writeFileSync(
      join(attemptDir, 'validation-error.json'),
      JSON.stringify({ error }, null, 2),
      { encoding: 'utf-8', mode: 0o600 }
    );
  }

  if (kimiOutput !== undefined) {
    writeFileSync(
      join(attemptDir, 'parsed-kimi-output.json'),
      JSON.stringify(kimiOutput, null, 2),
      { encoding: 'utf-8', mode: 0o600 }
    );
  }

  if (classified !== undefined) {
    writeFileSync(
      join(attemptDir, 'proposed-files.json'),
      JSON.stringify(classified.files, null, 2),
      { encoding: 'utf-8', mode: 0o600 }
    );
    writeFileSync(
      join(attemptDir, 'apply-plan.json'),
      JSON.stringify(
        {
          phase,
          classification: classified.classification,
          summary: classified.summary,
          file_count: classified.files.length,
        },
        null,
        2
      ),
      { encoding: 'utf-8', mode: 0o600 }
    );
  }

  if (manifest) {
    writeFileSync(
      join(attemptDir, 'patch-manifest.json'),
      JSON.stringify(manifest, null, 2),
      { encoding: 'utf-8', mode: 0o600 }
    );
  }

  const gitStatus = spawnSync('git', ['status', '--short'], {
    cwd: repoPath,
    encoding: 'utf-8',
    shell: false,
  });
  const gitDiffNameOnly = spawnSync('git', ['diff', '--name-only'], {
    cwd: repoPath,
    encoding: 'utf-8',
    shell: false,
  });
  const gitDiffStat = spawnSync('git', ['diff', '--stat'], {
    cwd: repoPath,
    encoding: 'utf-8',
    shell: false,
  });

  writeFileSync(
    join(attemptDir, 'post-apply-git.json'),
    JSON.stringify(
      {
        phase,
        git_status_short: gitStatus.status === 0 ? gitStatus.stdout : '',
        git_diff_name_only: gitDiffNameOnly.status === 0 ? gitDiffNameOnly.stdout : '',
        git_diff_stat: gitDiffStat.status === 0 ? gitDiffStat.stdout : '',
      },
      null,
      2
    ),
    { encoding: 'utf-8', mode: 0o600 }
  );
}

export function buildNoEffectRecoveryPrompt(
  task: Task,
  classification: KimiOutputClassification,
  classifiedFiles: ClassifiedProposedFile[]
): string {
  const previousPaths =
    classifiedFiles.length > 0
      ? classifiedFiles.map((f) => `${f.path} (${f.effect})`).join(', ')
      : '(none)';
  return [
    'The previous coder response was structurally valid but produced no actual changes.',
    `Classification: ${classification}`,
    `Previously proposed paths: ${previousPaths}`,
    '',
    'Task:',
    `- id: ${task.id}`,
    `- goal: ${task.goal}`,
    `- allowed scope: ${(task.guardrails.allow_modify ?? []).join(', ')}`,
    '',
    'You must return a response that creates or modifies at least one file within the allowed scope.',
    'A new file with empty content still counts as a real change, but only if the task requires creating that file.',
    'Do not repeat the same identical content for files that already exist.',
    'Do not modify files outside the allowed scope.',
    'Do not modify already-completed dependency artifacts unless the task explicitly requires it.',
    '',
    'Return ONLY valid JSON matching the original schema with at least one effective file update.',
  ].join('\n');
}

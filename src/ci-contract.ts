/**
 * Deterministic CI contract validation (TypeScript mirror).
 *
 * This module mirrors scripts/ci-contract-lib.mjs (the dependency-free CLI
 * implementation used by `npm run verify:ci-contract`). The logic must stay
 * identical: workflow `npm run <script>` commands must reference existing
 * package.json scripts, and package scripts of the form
 * `node scripts/foo.mjs` / `tsx scripts/foo.ts` must reference existing files.
 *
 * In-process use lets integrated validation and CI repair enforce the
 * contract without spawning node.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

export interface CiContractViolation {
  kind: 'missing_npm_script' | 'missing_script_target_file';
  workflow_file: string;
  job: string | null;
  step: string | null;
  npm_script: string | null;
  target_file: string | null;
  message: string;
}

export interface CiContractReport {
  ok: boolean;
  violations: CiContractViolation[];
  workflow_npm_scripts: Array<{ workflow_file: string; job: string | null; step: string | null; script: string }>;
  script_target_files: Array<{ script: string; target_file: string }>;
}

const NPM_RUN_RE = /\bnpm\s+run\s+([A-Za-z0-9:_-]+)/g;
const SCRIPT_TARGET_RE =
  /^(?:node|tsx)\s+((?:\.\/)?(?:[A-Za-z0-9_@.-]+\/)*[A-Za-z0-9_@.-]+\.(?:mjs|cjs|js|ts|mts|cts))\b/;

export function extractWorkflowCommands(
  workflowYaml: string
): Array<{ job: string | null; step: string | null; run: string }> {
  const commands: Array<{ job: string | null; step: string | null; run: string }> = [];
  const lines = workflowYaml.split(/\r?\n/);

  let job: string | null = null;
  let step: string | null = null;
  let inRunBlock = false;
  let runBlockIndent = 0;
  let runText = '';

  function flushRun(): void {
    if (inRunBlock) {
      const run = runText.replace(/\n+$/, '');
      if (run.trim().length > 0) {
        commands.push({ job, step, run });
      }
    }
    inRunBlock = false;
    runText = '';
  }

  for (const rawLine of lines) {
    const indent = rawLine.length - rawLine.trimStart().length;
    const trimmed = rawLine.trim();

    const jobMatch = rawLine.match(/^  ([A-Za-z0-9_-]+):\s*$/);
    if (jobMatch && !inRunBlock) {
      flushRun();
      job = jobMatch[1];
      step = null;
      continue;
    }

    const stepNameMatch = rawLine.match(/^      - name:\s*(.+)$/);
    if (stepNameMatch) {
      flushRun();
      step = stepNameMatch[1].trim().replace(/^['"]|['"]$/g, '');
      continue;
    }

    if (inRunBlock) {
      if (trimmed.length === 0) {
        runText += '\n';
        continue;
      }
      if (indent > runBlockIndent) {
        runText += `${trimmed}\n`;
        continue;
      }
      flushRun();
    }

    const runMatch = rawLine.match(/^(\s*)run:\s*(.*)$/);
    if (runMatch) {
      const inline = runMatch[2].trim();
      if (inline.length > 0 && !inline.startsWith('|') && !inline.startsWith('>')) {
        commands.push({ job, step, run: inline });
      } else {
        inRunBlock = true;
        runBlockIndent = runMatch[1].length;
        runText = '';
      }
      continue;
    }

    if (indent <= 2 && trimmed.length > 0 && !trimmed.startsWith('-')) {
      flushRun();
      if (indent < 2) {
        job = null;
        step = null;
      }
    }
  }
  flushRun();

  return commands;
}

export function extractScriptTargetFiles(
  scripts: Record<string, string>
): Array<{ script: string; target_file: string }> {
  const targets: Array<{ script: string; target_file: string }> = [];
  for (const [script, body] of Object.entries(scripts)) {
    const match = body.trim().match(SCRIPT_TARGET_RE);
    if (match) {
      targets.push({ script, target_file: match[1].replace(/^\.\//, '') });
    }
  }
  return targets;
}

export function validateRepoCiContract(
  repoRoot: string,
  options: { workflow_files?: string[] } = {}
): CiContractReport {
  const root = resolve(repoRoot);
  const violations: CiContractViolation[] = [];
  const workflowNpmScripts: CiContractReport['workflow_npm_scripts'] = [];

  let pkgScripts: Record<string, string> = {};
  try {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8')) as Record<string, unknown>;
    if (pkg.scripts && typeof pkg.scripts === 'object') {
      pkgScripts = pkg.scripts as Record<string, string>;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    violations.push({
      kind: 'missing_npm_script',
      workflow_file: 'package.json',
      job: null,
      step: null,
      npm_script: null,
      target_file: null,
      message: `Cannot read package.json scripts: ${message}`,
    });
  }

  let workflowFiles = options.workflow_files;
  if (!workflowFiles) {
    const workflowsDir = join(root, '.github', 'workflows');
    workflowFiles = existsSync(workflowsDir)
      ? readdirSync(workflowsDir)
          .filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
          .map((f) => `.github/workflows/${f}`)
      : [];
  }

  for (const workflowFile of workflowFiles) {
    let yaml: string;
    try {
      yaml = readFileSync(join(root, workflowFile), 'utf-8');
    } catch {
      violations.push({
        kind: 'missing_npm_script',
        workflow_file: workflowFile,
        job: null,
        step: null,
        npm_script: null,
        target_file: null,
        message: `Workflow file is not readable: ${workflowFile}`,
      });
      continue;
    }

    for (const command of extractWorkflowCommands(yaml)) {
      NPM_RUN_RE.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = NPM_RUN_RE.exec(command.run)) !== null) {
        const script = match[1];
        workflowNpmScripts.push({ workflow_file: workflowFile, job: command.job, step: command.step, script });
        if (!(script in pkgScripts)) {
          violations.push({
            kind: 'missing_npm_script',
            workflow_file: workflowFile,
            job: command.job,
            step: command.step,
            npm_script: script,
            target_file: null,
            message:
              `CI CONTRACT VIOLATION: workflow job "${command.job ?? 'unknown'}" step "${command.step ?? 'unknown'}" ` +
              `runs "npm run ${script}" but package.json has no script "${script}"`,
          });
        }
      }
    }
  }

  const scriptTargetFiles = extractScriptTargetFiles(pkgScripts);
  for (const target of scriptTargetFiles) {
    if (!existsSync(join(root, target.target_file))) {
      violations.push({
        kind: 'missing_script_target_file',
        workflow_file: 'package.json',
        job: null,
        step: null,
        npm_script: target.script,
        target_file: target.target_file,
        message:
          `CI CONTRACT VIOLATION: package.json script "${target.script}" references missing file ` +
          `"${target.target_file}"`,
      });
    }
  }

  return {
    ok: violations.length === 0,
    violations,
    workflow_npm_scripts: workflowNpmScripts,
    script_target_files: scriptTargetFiles,
  };
}

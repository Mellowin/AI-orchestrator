#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadTask } from './task-loader.js';
import { loadState, saveState, initState, getRunDir } from './state-manager.js';
import { buildContext } from './context-builder.js';
import { validateFileList, validateProposedFileLineDeltas } from './guardrails.js';
import { runChecks } from './runner.js';
import {
  ensureClean,
  getCurrentBranch,
  branchExists,
  getChangedFiles,
  getDiffStat,
} from './git-manager.js';
import { parseKimiOutputJson } from './kimi-output-validator.js';
import type { KimiOutput } from './types.js';
import { buildKimiPrompt } from './prompt-builder.js';
import { runMockApplyFlow } from './mock-apply-flow.js';
import { config } from './config.js';
import { createAIClientFromConfig } from './ai-client-factory.js';
import { resolveBackupPath } from './backup-path.js';

function countLines(text: string): number {
  if (text.length === 0) return 0;
  const lines = text.split('\n');
  return text.endsWith('\n') ? lines.length - 1 : lines.length;
}

function getTasksFilePath(): string {
  return process.env.TASKS_FILE?.trim() || 'tasks.yaml';
}

function validateKimiOutputForTask(raw: string, taskId: string): KimiOutput {
  const kimiOutput = parseKimiOutputJson(raw);
  const task = loadTask(getTasksFilePath(), taskId);
  const updatePaths = kimiOutput.files.map((f) => f.path);
  const guardrailsResult = validateFileList(updatePaths, task.guardrails);
  if (!guardrailsResult.ok) {
    throw new Error(`Guardrails failed: ${guardrailsResult.reason}`);
  }
  return kimiOutput;
}

async function executeAiGenerate(taskId: string, allowRealAI: boolean): Promise<{ outputPath: string; backupPath?: string }> {
  const task = loadTask(getTasksFilePath(), taskId);
  const context = buildContext(task);
  const prompt = buildKimiPrompt(context);

  if (config.ai.provider !== 'mock' && !allowRealAI) {
    throw new Error('real AI providers require --allow-real-ai');
  }

  const client = createAIClientFromConfig(config.ai);
  const output = await client.generate(prompt);

  const runDir = getRunDir(taskId);
  if (!existsSync(runDir)) {
    mkdirSync(runDir, { recursive: true });
  }
  const outPath = join(runDir, 'ai-output.json');
  let backupPath: string | undefined;
  if (existsSync(outPath)) {
    backupPath = resolveBackupPath(runDir, new Date());
    const oldContent = readFileSync(outPath, 'utf-8');
    writeFileSync(backupPath, oldContent, 'utf-8');
  }
  writeFileSync(outPath, output, 'utf-8');
  return { outputPath: outPath, backupPath };
}

function executeAiValidate(taskId: string): KimiOutput {
  const outputPath = join(getRunDir(taskId), 'ai-output.json');
  if (!existsSync(outputPath)) {
    throw new Error('ai-output.json not found. Run ai-generate first.');
  }
  if (!statSync(outputPath).isFile()) {
    throw new Error('ai-output.json is not a file');
  }
  const raw = readFileSync(outputPath, 'utf-8');
  return validateKimiOutputForTask(raw, taskId);
}

function executeAiPreview(taskId: string): { filesCount: number; notes?: string } {
  const outputPath = join(getRunDir(taskId), 'ai-output.json');
  if (!existsSync(outputPath)) {
    throw new Error('ai-output.json not found. Run ai-generate first.');
  }
  if (!statSync(outputPath).isFile()) {
    throw new Error('ai-output.json is not a file');
  }
  const raw = readFileSync(outputPath, 'utf-8');
  const kimiOutput = validateKimiOutputForTask(raw, taskId);
  const task = loadTask(getTasksFilePath(), taskId);

  if (kimiOutput.files.length > 0) {
    validateProposedFileLineDeltas(
      task.repo_path,
      kimiOutput.files,
      task.guardrails.max_lines_changed
    );

    for (const file of kimiOutput.files) {
      const filePath = join(task.repo_path, file.path);
      const fileExists = existsSync(filePath);
      let currentLines = 0;
      if (fileExists) {
        currentLines = countLines(readFileSync(filePath, 'utf-8'));
      }
      const proposedLines = countLines(file.content);
      const delta = proposedLines - currentLines;
      const deltaStr = delta >= 0 ? `+${delta}` : `${delta}`;

      console.log(`  - ${file.path}`);
      console.log(`    exists: ${fileExists ? 'yes' : 'no'}`);
      console.log(`    current lines: ${currentLines}`);
      console.log(`    proposed lines: ${proposedLines}`);
      console.log(`    delta: ${deltaStr}`);
    }
  }

  return { filesCount: kimiOutput.files.length, notes: kimiOutput.notes };
}

const args = process.argv.slice(2);
const command = args[0];
const taskId = args[1];

if (!command || !taskId) {
  console.error(
    'Usage: npx tsx src/cli.ts <run|status|git-check|git-diff|mock-apply|attempt|context|prompt|validate-output|ai-generate|ai-validate|ai-preview|ai-apply|ai-run> <taskId> [arg3]'
  );
  process.exit(1);
}

if (command === 'status') {
  try {
    const task = loadTask(getTasksFilePath(), taskId);
    const state = loadState(taskId);

    console.log(`[status] Task: ${taskId}`);
    console.log(`Title: ${task.title}`);

    if (!state) {
      console.log('No runs recorded yet.');
      console.log(`Start with: npx tsx src/cli.ts run ${taskId}`);
    } else {
      console.log(`Status: ${state.status}`);
      console.log(`Attempt: ${state.current_attempt}`);
      console.log(`Branch: ${state.branch}`);
      console.log(`Updated: ${state.updated_at}`);

      const rawLogs = state.last_logs?.trimEnd() ?? '';
      if (rawLogs.length > 0) {
        const lines = rawLogs.split('\n').slice(-20);
        console.log('Last logs:');
        console.log(lines.join('\n'));
      } else {
        console.log('Last logs: none');
      }

      const runDir = getRunDir(taskId);
      let attempts: string[] = [];
      if (existsSync(runDir)) {
        const entries = readdirSync(runDir, { withFileTypes: true });
        attempts = entries
          .filter((e) => e.isDirectory() && /^attempt-\d+$/.test(e.name))
          .map((e) => e.name)
          .sort((a, b) => {
            const numA = parseInt(a.replace('attempt-', ''), 10);
            const numB = parseInt(b.replace('attempt-', ''), 10);
            return numA - numB;
          });
      }

      if (attempts.length > 0) {
        console.log('Attempts:');
        for (const attempt of attempts) {
          console.log(`  - ${attempt}`);
        }
      } else {
        console.log('Attempts: none');
      }
    }
    process.exit(0);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[status] Error: ${message}`);
    process.exit(1);
  }
}

if (command === 'git-check') {
  try {
    const task = loadTask(getTasksFilePath(), taskId);
    const exists = branchExists(task.repo_path, task.work_branch);
    ensureClean(task.repo_path);
    const current = getCurrentBranch(task.repo_path);

    console.log(`[git-check] Task: ${taskId}`);
    console.log(`[git-check] Repo: ${task.repo_path}`);
    console.log(`[git-check] Current branch: ${current}`);
    console.log(
      `[git-check] Work branch "${task.work_branch}" exists: ${exists}`
    );
    console.log(`[git-check] Clean: true`);
    process.exit(0);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[git-check] Error: ${message}`);
    process.exit(1);
  }
}

if (command === 'git-diff') {
  try {
    const task = loadTask(getTasksFilePath(), taskId);
    const changed = getChangedFiles(task.repo_path);
    const stat = getDiffStat(task.repo_path);

    console.log(`[git-diff] Task: ${taskId}`);
    console.log(`[git-diff] Changed files: ${changed.length}`);
    console.log(`[git-diff] Insertions: ${stat.insertions}`);
    console.log(`[git-diff] Deletions: ${stat.deletions}`);
    console.log(`[git-diff] Binary files: ${stat.binaryFiles.length}`);
    process.exit(0);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[git-diff] Error: ${message}`);
    process.exit(1);
  }
}

if (command === 'mock-apply') {
  const jsonPath = args[2];
  if (!jsonPath) {
    console.error('Usage: npx tsx src/cli.ts mock-apply <taskId> <jsonPath>');
    process.exit(1);
  }
  try {
    if (!existsSync(jsonPath)) {
      throw new Error(`jsonPath does not exist: ${jsonPath}`);
    }
    const stats = statSync(jsonPath);
    if (!stats.isFile()) {
      throw new Error(`jsonPath is not a file: ${jsonPath}`);
    }

    const task = loadTask(getTasksFilePath(), taskId);
    const rawJson = readFileSync(jsonPath, 'utf-8');
    const result = runMockApplyFlow(task, rawJson);

    if (result.success) {
      console.log('[mock-apply] Success');
      console.log(result.logs);
      process.exit(0);
    } else {
      console.error('[mock-apply] Failed');
      console.error(result.logs);
      process.exit(1);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[mock-apply] Error: ${message}`);
    process.exit(1);
  }
}

if (command === 'run') {
  try {
    const task = loadTask(getTasksFilePath(), taskId);
    let state = loadState(taskId);

    if (!state) {
      state = initState(task);
      saveState(taskId, state);
      console.log(`[run] Initialized new state for task "${taskId}"`);
    } else {
      console.log(`[run] Existing state found for task "${taskId}"`);
    }

    console.log('[run] Current state:\n');
    console.log(JSON.stringify(state, null, 2));

    const context = buildContext(task);
    console.log(`\n[run] Context files: ${context.files.length}`);
    for (const f of context.files) {
      console.log(`  - ${f.path}`);
    }

    const guardrailsResult = validateFileList(
      task.context_files,
      task.guardrails
    );
    if (!guardrailsResult.ok) {
      console.error(`\n[run] Guardrails context file check: failed`);
      console.error(`[run] ${guardrailsResult.reason}`);
      process.exit(1);
    }
    console.log(`[run] Guardrails context file check: ok`);

    const checkResult = runChecks(task.repo_path, task.checks);
    if (!checkResult.success) {
      console.error(`\n[run] Checks: failed`);
      console.error(
        `[run] Failed command: ${checkResult.failedStep?.command} ${checkResult.failedStep?.args?.join(' ')}`
      );
      console.error(`[run] Logs:\n${checkResult.logs}`);
      process.exit(1);
    }
    console.log(`[run] Checks: ok`);

    process.exit(0);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[run] Error: ${message}`);
    process.exit(1);
  }
}

if (command === 'attempt') {
  const attemptArg = args[2];
  if (!attemptArg) {
    console.error('Usage: npx tsx src/cli.ts attempt <taskId> <attemptNumber>');
    process.exit(1);
  }
  if (!/^[1-9]\d*$/.test(attemptArg)) {
    console.error(`[attempt] Invalid attempt number: ${attemptArg}`);
    process.exit(1);
  }
  const attemptNumber = Number(attemptArg);

  try {
    const attemptDir = join(getRunDir(taskId), `attempt-${attemptNumber}`);
    if (!existsSync(attemptDir)) {
      console.error(`[attempt] Not found: attempt-${attemptNumber}`);
      process.exit(1);
    }
    const attemptStats = statSync(attemptDir);
    if (!attemptStats.isDirectory()) {
      console.error(`[attempt] Not found: attempt-${attemptNumber}`);
      process.exit(1);
    }

    console.log(`[attempt] Task: ${taskId}`);
    console.log(`[attempt] Attempt: attempt-${attemptNumber}`);

    const entries = readdirSync(attemptDir, { withFileTypes: true });
    const files = entries.filter((e) => e.isFile()).map((e) => e.name);

    const priority = [
      'raw-kimi-output.json',
      'parsed-kimi-output.json',
      'patch-manifest.json',
      'logs.txt',
    ];
    const sorted = files.sort((a, b) => {
      const idxA = priority.indexOf(a);
      const idxB = priority.indexOf(b);
      if (idxA !== -1 && idxB !== -1) return idxA - idxB;
      if (idxA !== -1) return -1;
      if (idxB !== -1) return 1;
      return a.localeCompare(b);
    });

    if (sorted.length > 0) {
      console.log('Files:');
      for (const file of sorted) {
        console.log(`  - ${file}`);
      }
    } else {
      console.log('Files: none');
    }

    const logsPath = join(attemptDir, 'logs.txt');
    if (existsSync(logsPath)) {
      const rawLogs = readFileSync(logsPath, 'utf-8').trimEnd();
      if (rawLogs.length > 0) {
        const lines = rawLogs.split('\n').slice(-40);
        console.log('Last logs:');
        console.log(lines.join('\n'));
      }
    }

    process.exit(0);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[attempt] Error: ${message}`);
    process.exit(1);
  }
}

if (command === 'context') {
  try {
    const task = loadTask(getTasksFilePath(), taskId);
    const context = buildContext(task);

    const runDir = getRunDir(taskId);
    if (!existsSync(runDir)) {
      mkdirSync(runDir, { recursive: true });
    }
    const outPath = join(runDir, 'context-package.json');
    writeFileSync(outPath, JSON.stringify(context, null, 2), 'utf-8');

    console.log(`[context] Task: ${taskId}`);
    console.log(`[context] Files: ${context.files.length}`);
    console.log(`[context] Written: ${outPath}`);
    process.exit(0);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[context] Error: ${message}`);
    process.exit(1);
  }
}

if (command === 'prompt') {
  try {
    const task = loadTask(getTasksFilePath(), taskId);
    const context = buildContext(task);

    const runDir = getRunDir(taskId);
    if (!existsSync(runDir)) {
      mkdirSync(runDir, { recursive: true });
    }

    const contextPath = join(runDir, 'context-package.json');
    writeFileSync(contextPath, JSON.stringify(context, null, 2), 'utf-8');

    const promptPath = join(runDir, 'kimi-prompt.md');
    const prompt = buildKimiPrompt(context);

    writeFileSync(promptPath, prompt, 'utf-8');

    console.log(`[prompt] Task: ${taskId}`);
    console.log(`[prompt] Files: ${context.files.length}`);
    console.log(`[prompt] Written: ${promptPath}`);
    process.exit(0);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[prompt] Error: ${message}`);
    process.exit(1);
  }
}

if (command === 'validate-output') {
  const jsonPath = args[2];
  if (!jsonPath) {
    console.error('Usage: npx tsx src/cli.ts validate-output <taskId> <jsonPath>');
    process.exit(1);
  }
  try {
    if (!existsSync(jsonPath)) {
      throw new Error(`jsonPath does not exist: ${jsonPath}`);
    }
    const stats = statSync(jsonPath);
    if (!stats.isFile()) {
      throw new Error(`jsonPath is not a file: ${jsonPath}`);
    }

    const rawJson = readFileSync(jsonPath, 'utf-8');
    const kimiOutput = validateKimiOutputForTask(rawJson, taskId);

    console.log(`[validate-output] Task: ${taskId}`);
    console.log('[validate-output] Valid Kimi output');
    console.log(`[validate-output] Files: ${kimiOutput.files.length}`);
    for (const file of kimiOutput.files) {
      console.log(`  - ${file.path}`);
    }
    console.log('[validate-output] Guardrails: ok');
    process.exit(0);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.startsWith('Guardrails failed:')) {
      console.error(`[validate-output] ${message}`);
    } else {
      console.error(`[validate-output] Error: ${message}`);
    }
    process.exit(1);
  }
}

if (command === 'ai-generate') {
  try {
    const allowRealAI = args.includes('--allow-real-ai');
    const result = await executeAiGenerate(taskId, allowRealAI);
    console.log(`[ai-generate] Task: ${taskId}`);
    console.log(`[ai-generate] Provider: ${config.ai.provider}`);
    console.log(`[ai-generate] Written: ${result.outputPath}`);
    if (result.backupPath) {
      console.log(`[ai-generate] Backup: ${result.backupPath}`);
    }
    process.exitCode = 0;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[ai-generate] Error: ${message}`);
    process.exit(1);
  }
}

if (command === 'ai-validate') {
  try {
    const kimiOutput = executeAiValidate(taskId);

    console.log(`[ai-validate] Task: ${taskId}`);
    console.log('[ai-validate] Valid AI output');
    console.log(`[ai-validate] Files: ${kimiOutput.files.length}`);
    if (kimiOutput.files.length === 0) {
      console.log('[ai-validate] No file changes proposed');
      if (kimiOutput.notes) {
        console.log(`[ai-validate] Notes: ${kimiOutput.notes}`);
      }
      console.log('[ai-validate] Guardrails: ok');
      process.exit(0);
    }
    for (const file of kimiOutput.files) {
      console.log(`  - ${file.path}`);
    }
    console.log('[ai-validate] Guardrails: ok');
    process.exit(0);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.startsWith('Guardrails failed:')) {
      console.error(`[ai-validate] ${message}`);
    } else {
      console.error(`[ai-validate] Error: ${message}`);
    }
    process.exit(1);
  }
}

if (command === 'ai-preview') {
  try {
    console.log(`[ai-preview] Task: ${taskId}`);
    const previewResult = executeAiPreview(taskId);
    console.log(`[ai-preview] Files: ${previewResult.filesCount}`);
    if (previewResult.filesCount === 0) {
      console.log('[ai-preview] No file changes proposed');
      if (previewResult.notes) {
        console.log(`[ai-preview] Notes: ${previewResult.notes}`);
      }
    }
    process.exitCode = 0;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.startsWith('Guardrails failed:')) {
      console.error(`[ai-preview] ${message}`);
    } else {
      console.error(`[ai-preview] Error: ${message}`);
    }
    process.exit(1);
  }
}

if (command === 'ai-run') {
  try {
    const allowRealAI = args.includes('--allow-real-ai');
    console.log(`[ai-run] Task: ${taskId}`);

    console.log(`[ai-run] Step 1/3: ai-generate`);
    const generateResult = await executeAiGenerate(taskId, allowRealAI);
    console.log(`[ai-run] ai-generate: ok`);
    if (generateResult.backupPath) {
      console.log(`[ai-run] Backup: ${generateResult.backupPath}`);
    }

    console.log(`[ai-run] Step 2/3: ai-validate`);
    executeAiValidate(taskId);
    console.log(`[ai-run] ai-validate: ok`);

    console.log(`[ai-run] Step 3/3: ai-preview`);
    const previewResult = executeAiPreview(taskId);
    if (previewResult.filesCount === 0) {
      console.log('[ai-run] No file changes proposed');
      if (previewResult.notes) {
        console.log(`[ai-run] Notes: ${previewResult.notes}`);
      }
    }
    console.log(`[ai-run] ai-preview: ok`);

    console.log(`[ai-run] Done. Review preview output, then run ai-apply manually if acceptable.`);
    process.exitCode = 0;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[ai-run] Error: ${message}`);
    process.exit(1);
  }
}

if (command === 'ai-apply') {
  try {
    const outputPath = join(getRunDir(taskId), 'ai-output.json');
    if (!existsSync(outputPath)) {
      console.error(
        '[ai-apply] Error: ai-output.json not found. Run ai-generate first.'
      );
      process.exit(1);
    }
    const stats = statSync(outputPath);
    if (!stats.isFile()) {
      console.error('[ai-apply] Error: ai-output.json is not a file');
      process.exit(1);
    }

    const raw = readFileSync(outputPath, 'utf-8');
    const kimiOutput = validateKimiOutputForTask(raw, taskId);

    if (kimiOutput.files.length === 0) {
      console.log('[ai-apply] No file changes proposed');
      if (kimiOutput.notes) {
        console.log(`[ai-apply] Notes: ${kimiOutput.notes}`);
      }
      process.exit(0);
    }

    const task = loadTask(getTasksFilePath(), taskId);
    const result = runMockApplyFlow(task, raw);

    if (result.success) {
      console.log('[ai-apply] Success');
      console.log(result.logs);
      process.exit(0);
    } else {
      console.error('[ai-apply] Failed');
      console.error(result.logs);
      process.exit(1);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.startsWith('Guardrails failed:')) {
      console.error(`[ai-apply] ${message}`);
    } else {
      console.error(`[ai-apply] Error: ${message}`);
    }
    process.exit(1);
  }
}

if (process.exitCode === undefined) {
  console.error(`Unknown command: ${command}`);
  process.exit(1);
}

#!/usr/bin/env node
import { existsSync, readFileSync, statSync } from 'node:fs';
import { loadTask } from './task-loader.js';
import { loadState, saveState, initState } from './state-manager.js';
import { buildContext } from './context-builder.js';
import { validateFileList } from './guardrails.js';
import { runChecks } from './runner.js';
import {
  ensureClean,
  getCurrentBranch,
  branchExists,
  getChangedFiles,
  getDiffStat,
} from './git-manager.js';
import { runMockApplyFlow } from './mock-apply-flow.js';

const args = process.argv.slice(2);
const command = args[0];
const taskId = args[1];

if (!command || !taskId) {
  console.error(
    'Usage: npx tsx src/cli.ts <run|status|git-check|git-diff|mock-apply> <taskId> [jsonPath]'
  );
  process.exit(1);
}

if (command === 'status') {
  try {
    const task = loadTask('tasks.yaml', taskId);
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
    const task = loadTask('tasks.yaml', taskId);
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
    const task = loadTask('tasks.yaml', taskId);
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

    const task = loadTask('tasks.yaml', taskId);
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
    const task = loadTask('tasks.yaml', taskId);
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

console.error(`Unknown command: ${command}`);
process.exit(1);

#!/usr/bin/env node
import { loadTask } from './task-loader.js';
import { loadState, saveState, initState } from './state-manager.js';
import { buildContext } from './context-builder.js';

const args = process.argv.slice(2);
const command = args[0];
const taskId = args[1];

if (!command || !taskId) {
  console.error('Usage: npx tsx src/cli.ts <run|status> <taskId>');
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

    process.exit(0);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[run] Error: ${message}`);
    process.exit(1);
  }
}

console.error(`Unknown command: ${command}`);
process.exit(1);

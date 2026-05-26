#!/usr/bin/env node
import { loadTask } from './task-loader.js';

const args = process.argv.slice(2);
const command = args[0];
const taskId = args[1];

if (!command || !taskId) {
  console.error('Usage: npx tsx src/cli.ts <run|status> <taskId>');
  process.exit(1);
}

if (command === 'status') {
  console.log(`[status] Task: ${taskId}`);
  console.log('No runs recorded yet.');
  console.log(`Start with: npx tsx src/cli.ts run ${taskId}`);
  process.exit(0);
}

if (command === 'run') {
  try {
    const task = loadTask('tasks.yaml', taskId);
    console.log('[run] Task loaded successfully:\n');
    console.log(JSON.stringify(task, null, 2));
    process.exit(0);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[run] Error: ${message}`);
    process.exit(1);
  }
}

console.error(`Unknown command: ${command}`);
process.exit(1);

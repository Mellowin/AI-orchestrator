import { readFileSync, existsSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const filePath = 'docs/live-stage-6-16-task-2.md';
const statePath = join(tmpdir(), 'stage-6-16-task-2-state.txt');

if (!existsSync(filePath)) {
  console.error('FAIL: file missing');
  process.exit(1);
}

const content = readFileSync(filePath, 'utf-8');
let phase = 0;

if (existsSync(statePath)) {
  phase = parseInt(readFileSync(statePath, 'utf-8').trim(), 10) || 0;
}

if (phase === 0) {
  if (content.includes('TASK_2_FIX_MARKER')) {
    console.error('TASK_2_FIX_MARKER appeared too early. Do not add it on initial attempt.');
    process.exit(1);
  }
  writeFileSync(statePath, '1');
  console.error('Missing required marker: TASK_2_FIX_MARKER. Add exactly TASK_2_FIX_MARKER in the next fix attempt.');
  process.exit(1);
}

if (phase === 1) {
  const required = [
    'Stage 6.16',
    'TASK_2_FIX_LOOP',
    'KIMI_CODER',
    'KIMI_REVIEWER',
    'FINAL_ACCEPTED',
    '## Fix Evidence',
    'TASK_2_FIX_MARKER',
  ];
  for (const marker of required) {
    if (!content.includes(marker)) {
      console.error(`FAIL: missing marker: ${marker}`);
      process.exit(1);
    }
  }
  console.log('PASS: all markers found');
  process.exit(0);
}

console.error('Unknown phase');
process.exit(1);

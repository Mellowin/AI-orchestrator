import { readFileSync, existsSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const filePath = 'docs/live-stage-6-15-2-multi-retry-proof.md';
const statePath = join(tmpdir(), 'stage-6-15-2-multi-retry-state.txt');

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
  if (content.includes('FIRST_FIX_MARKER')) {
    console.error('FIRST_FIX_MARKER appeared too early. Do not add it on initial attempt.');
    process.exit(1);
  }
  writeFileSync(statePath, '1');
  console.error('Missing required marker for fix phase 1: FIRST_FIX_MARKER. Add exactly FIRST_FIX_MARKER in the next fix attempt. Do not add SECOND_FIX_MARKER yet.');
  process.exit(1);
}

if (phase === 1) {
  if (!content.includes('FIRST_FIX_MARKER')) {
    console.error('Missing required marker for fix phase 1: FIRST_FIX_MARKER. Add exactly FIRST_FIX_MARKER in the next fix attempt. Do not add SECOND_FIX_MARKER yet.');
    process.exit(1);
  }
  if (content.includes('SECOND_FIX_MARKER')) {
    console.error('Future marker appeared too early. Keep only the marker requested for the current fix phase.');
    process.exit(1);
  }
  writeFileSync(statePath, '2');
  console.error('Missing required marker for fix phase 2: SECOND_FIX_MARKER. Add exactly SECOND_FIX_MARKER in the next fix attempt.');
  process.exit(1);
}

if (phase === 2) {
  const required = [
    'Stage 6.15.2',
    'FULL_FIX_LOOP_MATRIX',
    'KIMI_CODER',
    'KIMI_REVIEWER',
    'FINAL_ACCEPTED',
    '## Multi-Retry Evidence',
    'FIRST_FIX_MARKER',
    'SECOND_FIX_MARKER',
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

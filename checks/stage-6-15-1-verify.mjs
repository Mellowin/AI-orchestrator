import { readFileSync, existsSync } from 'fs';

const path = 'docs/live-stage-6-15-1-proof.md';

if (!existsSync(path)) {
  console.error('FAIL: file missing: docs/live-stage-6-15-1-proof.md');
  process.exit(1);
}

const content = readFileSync(path, 'utf-8');
const lines = content.split(/\r?\n/).map(l => l.trim());

const required = [
  'Stage 6.15.1',
  'FIX_LOOP_TRIGGERED',
  'KIMI_CODER',
  'KIMI_REVIEWER',
  'FINAL_ACCEPTED',
  '## Fix Loop Evidence',
];

for (const marker of required) {
  if (!content.includes(marker)) {
    console.error(`Missing required marker: ${marker}.`);
    process.exit(1);
  }
}

const hasSecondAttempt = lines.some(line => line === 'SECOND_ATTEMPT_FIX');
if (!hasSecondAttempt) {
  console.error('Missing required marker: SECOND_ATTEMPT_FIX. Add this exact marker on its own line in the next fix attempt.');
  process.exit(1);
}

console.log('PASS: all markers found');

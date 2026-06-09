const fs = require('fs');
const path = 'docs/live-stage-6-15-proof.md';

if (fs.existsSync(path)) {
  const content = fs.readFileSync(path, 'utf8');
  fs.writeFileSync('tmp/check-debug.txt', content);
} else {
  fs.writeFileSync('tmp/check-debug.txt', 'FILE MISSING');
}

if (!fs.existsSync(path)) {
  console.error('FAIL: file missing');
  process.exit(1);
}
const c = fs.readFileSync(path, 'utf8');
const markers = ['Stage 6.15', 'FIX_LOOP_PROOF', 'FINAL_ACCEPTED', 'KIMI_CODER', 'KIMI_REVIEWER', '## Fix Loop Evidence'];
for (const m of markers) {
  if (!c.includes(m)) {
    console.error('FAIL: missing ' + m);
    process.exit(1);
  }
}
console.log('PASS: all markers present');

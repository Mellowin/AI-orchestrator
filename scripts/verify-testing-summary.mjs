import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = resolve(__dirname, '..');

const errors = [];

function fail(message) {
  errors.push(message);
}

function runGit(args, options = {}) {
  const result = spawnSync('git', args, {
    cwd: ROOT,
    encoding: 'utf-8',
    shell: false,
    ...options,
  });
  return result;
}

function shaExists(sha) {
  const result = runGit(['cat-file', '-e', `${sha}^{commit}`]);
  return result.status === 0;
}

// 1. TESTING_SUMMARY.md exists.
const summaryPath = join(ROOT, 'TESTING_SUMMARY.md');
if (!existsSync(summaryPath)) {
  fail('TESTING_SUMMARY.md does not exist');
  report();
}

const summaryText = readFileSync(summaryPath, 'utf-8');

// 2. No placeholder markers in latest verification section.
const latestSectionMatch = summaryText.match(/Last verified commit:[\s\S]*?(?=## Documentation stages)/);
const latestSection = latestSectionMatch ? latestSectionMatch[0] : summaryText;

const placeholderPattern = /\b(pending|TODO|TBD|placeholder)\b/gi;
let placeholderMatch;
while ((placeholderMatch = placeholderPattern.exec(latestSection)) !== null) {
  fail(`TESTING_SUMMARY.md latest section contains placeholder: "${placeholderMatch[1]}"`);
}

// 3. Every full 40-char SHA exists in git history.
const shaPattern = /\b[0-9a-f]{40}\b/g;
const shas = [...summaryText.matchAll(shaPattern)].map((m) => m[0]);
const seen = new Set();
for (const sha of shas) {
  if (seen.has(sha)) continue;
  seen.add(sha);
  if (!shaExists(sha)) {
    fail(`TESTING_SUMMARY.md references commit not in git history: ${sha}`);
  }
}

// 4. No debug marker usage as actual logs anywhere in the repo text.
// Mentions inside the explicit "Debug markers:" confirmation line are allowed.
for (const marker of ['DEBUG_CHUNK2', 'CHECK_DEBUG']) {
  const offendingLines = summaryText
    .split('\n')
    .map((line, index) => ({ line, index: index + 1 }))
    .filter(({ line }) => line.includes(marker))
    .filter(({ line }) => !line.includes('Debug markers:') && !line.includes('absent'));
  for (const { line, index } of offendingLines) {
    fail(`TESTING_SUMMARY.md contains debug marker at line ${index}: ${marker} (line: ${line.trim()})`);
  }
}

// 5. Product verification workflow remains manual-only.
const workflowPath = join(ROOT, '.github', 'workflows', 'product-verify.yml');
if (!existsSync(workflowPath)) {
  fail('.github/workflows/product-verify.yml does not exist');
} else {
  const workflowText = readFileSync(workflowPath, 'utf-8');
  if (!workflowText.includes('workflow_dispatch')) {
    fail('.github/workflows/product-verify.yml must contain workflow_dispatch');
  }
  if (workflowText.includes('pull_request')) {
    fail('.github/workflows/product-verify.yml must not contain pull_request trigger');
  }
  if (workflowText.includes('push:')) {
    fail('.github/workflows/product-verify.yml must not contain push trigger');
  }
}

// 6. package.json has required scripts.
const packagePath = join(ROOT, 'package.json');
if (!existsSync(packagePath)) {
  fail('package.json does not exist');
} else {
  const pkg = JSON.parse(readFileSync(packagePath, 'utf-8'));
  const requiredScripts = [
    'verify:product',
    'verify:product:ci',
    'test:chunks:product',
    'test:chunks:product:ci',
  ];
  for (const script of requiredScripts) {
    if (typeof pkg.scripts?.[script] !== 'string') {
      fail(`package.json is missing required script: ${script}`);
    }
  }
}

function report() {
  if (errors.length > 0) {
    console.error('TESTING_SUMMARY verification failed:');
    for (const err of errors) {
      console.error(`  - ${err}`);
    }
    process.exit(1);
  }
  console.log('TESTING_SUMMARY verification passed.');
  console.log(`  - ${seen.size} unique commit SHA(s) verified in git history`);
  console.log('  - no placeholders in latest verification section');
  console.log('  - no DEBUG_CHUNK2 / CHECK_DEBUG markers');
  console.log('  - Product verification workflow is manual-only');
  console.log('  - required package scripts present');
  process.exit(0);
}

report();

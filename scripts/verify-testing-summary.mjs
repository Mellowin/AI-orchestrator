import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function runGit(args, cwd) {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf-8',
    shell: false,
  });
  return result;
}

function shaExists(sha, cwd, errors) {
  const result = runGit(['cat-file', '-e', `${sha}^{commit}`], cwd);
  if (result.status !== 0) {
    const err = (result.stderr || result.stdout || `exit ${result.status}`).trim();
    errors.push(`git cannot resolve commit ${sha}: ${err}`);
    return false;
  }
  return true;
}

function getParentSha(root) {
  const result = runGit(['rev-parse', 'HEAD~1'], root);
  return result.status === 0 ? result.stdout.trim() : '';
}

function getChangedFilesSinceParent(root) {
  const result = runGit(['diff', '--name-only', 'HEAD~1..HEAD'], root);
  if (result.status !== 0) {
    return null;
  }
  return result.stdout.trim().split('\n').filter(Boolean);
}

function isSummaryOnlyCommit(root, changedFilesOverride) {
  const files = Array.isArray(changedFilesOverride)
    ? changedFilesOverride
    : getChangedFilesSinceParent(root);
  if (!Array.isArray(files) || files.length === 0) {
    return false;
  }
  return files.every((file) => file === 'TESTING_SUMMARY.md');
}

export function validateTestingSummary({ summaryText, headSha, root, parentFiles }) {
  const errors = [];

  if (typeof summaryText !== 'string' || summaryText.length === 0) {
    errors.push('TESTING_SUMMARY.md content is missing');
    return { ok: false, errors, shasVerified: 0 };
  }

  if (!/^[0-9a-f]{40}$/i.test(headSha || '')) {
    errors.push(`current HEAD is not a valid 40-char SHA: ${headSha}`);
  }

  // 1. Isolate latest verification section.
  const latestSectionMatch = summaryText.match(/\*\*Last verified:\*\*[\s\S]*?(?=## Documentation stages)/);
  const latestSection = latestSectionMatch ? latestSectionMatch[0] : summaryText;

  // 2. No placeholder markers in latest verification section.
  const placeholderPattern = /\b(pending|TODO|TBD|placeholder)\b/gi;
  let placeholderMatch;
  while ((placeholderMatch = placeholderPattern.exec(latestSection)) !== null) {
    errors.push(`TESTING_SUMMARY.md latest section contains placeholder: "${placeholderMatch[1]}"`);
  }

  // 3. Last verified and Last verified commit must equal current HEAD.
  // Allow HEAD~1 only when the current commit is a docs-only update that
  // records the verification result of the previous (meaningful) commit.
  const lastVerifiedMatch = latestSection.match(/\*\*Last verified:\*\*\s*`([0-9a-f]{40})`/i);
  const lastVerifiedCommitMatch = latestSection.match(/\*\*Last verified commit:\*\*\s*`([0-9a-f]{40})`/i);

  const parentSha = getParentSha(root);
  const allowedHeadShas = new Set([headSha.toLowerCase()]);
  if (parentSha) {
    allowedHeadShas.add(parentSha.toLowerCase());
  }

  let matchedHead = false;
  let matchedParent = false;

  if (!lastVerifiedMatch) {
    errors.push('TESTING_SUMMARY.md latest section is missing "Last verified" SHA');
  } else if (lastVerifiedMatch[1].toLowerCase() === headSha.toLowerCase()) {
    matchedHead = true;
  } else if (parentSha && lastVerifiedMatch[1].toLowerCase() === parentSha.toLowerCase()) {
    matchedParent = true;
  } else {
    errors.push(
      `TESTING_SUMMARY.md "Last verified" (${lastVerifiedMatch[1]}) does not match current HEAD (${headSha}) or HEAD~1`
    );
  }

  if (!lastVerifiedCommitMatch) {
    errors.push('TESTING_SUMMARY.md latest section is missing "Last verified commit" SHA');
  } else if (lastVerifiedCommitMatch[1].toLowerCase() === headSha.toLowerCase()) {
    // ok
  } else if (parentSha && lastVerifiedCommitMatch[1].toLowerCase() === parentSha.toLowerCase()) {
    // ok
  } else {
    errors.push(
      `TESTING_SUMMARY.md "Last verified commit" (${lastVerifiedCommitMatch[1]}) does not match current HEAD (${headSha}) or HEAD~1`
    );
  }

  // 3a. HEAD~1 evidence is allowed only for a docs-only summary commit.
  if ((matchedParent || (lastVerifiedMatch && lastVerifiedMatch[1].toLowerCase() === parentSha.toLowerCase())) && parentSha) {
    if (!isSummaryOnlyCommit(root, parentFiles)) {
      const files = Array.isArray(parentFiles)
        ? parentFiles
        : getChangedFilesSinceParent(root) ?? [];
      const nonSummary = files.filter((file) => file !== 'TESTING_SUMMARY.md');
      errors.push(
        `Last verified points to HEAD~1 (${parentSha}) but the current commit is not docs-only. Non-summary files changed: ${nonSummary.join(', ')}`
      );
    }
  }

  // 4. Every full 40-char SHA in the latest verification section exists in git history.
  const shaPattern = /\b[0-9a-f]{40}\b/g;
  const shas = [...latestSection.matchAll(shaPattern)].map((m) => m[0]);
  const seen = new Set();
  let shasVerified = 0;
  for (const sha of shas) {
    if (seen.has(sha)) continue;
    seen.add(sha);
    if (shaExists(sha, root, errors)) {
      shasVerified++;
    }
  }

  // 5. No debug marker usage as actual logs in the latest verification section.
  for (const marker of ['DEBUG_CHUNK2', 'CHECK_DEBUG']) {
    const offendingLines = latestSection
      .split('\n')
      .map((line, index) => ({ line, index: index + 1 }))
      .filter(({ line }) => line.includes(marker))
      .filter(({ line }) => !line.includes('Debug markers:') && !line.includes('absent'));
    for (const { line, index } of offendingLines) {
      errors.push(`TESTING_SUMMARY.md contains debug marker at line ${index}: ${marker} (line: ${line.trim()})`);
    }
  }

  // 6. Product verification workflow remains manual-only.
  const workflowPath = join(root, '.github', 'workflows', 'product-verify.yml');
  if (!existsSync(workflowPath)) {
    errors.push('.github/workflows/product-verify.yml does not exist');
  } else {
    const workflowText = readFileSync(workflowPath, 'utf-8');
    if (!workflowText.includes('workflow_dispatch')) {
      errors.push('.github/workflows/product-verify.yml must contain workflow_dispatch');
    }
    if (workflowText.includes('pull_request')) {
      errors.push('.github/workflows/product-verify.yml must not contain pull_request trigger');
    }
    if (workflowText.includes('push:')) {
      errors.push('.github/workflows/product-verify.yml must not contain push trigger');
    }
  }

  // 7. package.json has required scripts.
  const packagePath = join(root, 'package.json');
  if (!existsSync(packagePath)) {
    errors.push('package.json does not exist');
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
        errors.push(`package.json is missing required script: ${script}`);
      }
    }
  }

  return { ok: errors.length === 0, errors, shasVerified, matchedHead, matchedParent };
}

function main() {
  const root = resolve(__dirname, '..');
  const summaryPath = join(root, 'TESTING_SUMMARY.md');

  if (!existsSync(summaryPath)) {
    console.error('TESTING_SUMMARY verification failed:');
    console.error('  - TESTING_SUMMARY.md does not exist');
    process.exit(1);
  }

  const summaryText = readFileSync(summaryPath, 'utf-8');
  const headResult = runGit(['rev-parse', 'HEAD'], root);
  const headSha = headResult.status === 0 ? headResult.stdout.trim() : '';

  const result = validateTestingSummary({ summaryText, headSha, root });

  if (!result.ok) {
    console.error('TESTING_SUMMARY verification failed:');
    for (const err of result.errors) {
      console.error(`  - ${err}`);
    }
    process.exit(1);
  }

  console.log('TESTING_SUMMARY verification passed.');
  console.log(`  - current HEAD: ${headSha}`);
  if (result.matchedHead) {
    console.log('  - Last verified matches HEAD');
  } else if (result.matchedParent) {
    console.log('  - Last verified matches HEAD~1 (docs-only summary commit)');
  }
  console.log(`  - ${result.shasVerified} unique commit SHA(s) in latest section verified in git history`);
  console.log('  - no placeholders in latest verification section');
  console.log('  - no DEBUG_CHUNK2 / CHECK_DEBUG markers');
  console.log('  - Product verification workflow is manual-only');
  console.log('  - required package scripts present');
  process.exit(0);
}

const isMain = process.argv[1] && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1]);
if (isMain) {
  main();
}

import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function runGit(args, cwd) {
  return spawnSync('git', args, {
    cwd,
    encoding: 'utf-8',
    shell: false,
  });
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

function isAncestorOfHead(sha, headSha, cwd, errors) {
  const result = runGit(['merge-base', '--is-ancestor', sha, headSha], cwd);
  if (result.status !== 0) {
    errors.push(
      `TESTING_SUMMARY.md Last verified commit (${sha}) is not an ancestor of current HEAD (${headSha})`
    );
    return false;
  }
  return true;
}

function getHeadSha(root) {
  const result = runGit(['rev-parse', 'HEAD'], root);
  return result.status === 0 ? result.stdout.trim() : '';
}

function getChangedFilesAfterVerified(root, verifiedSha, headSha) {
  const result = runGit(['diff', '--name-only', `${verifiedSha}..${headSha}`], root);
  if (result.status !== 0) {
    return [];
  }
  return result.stdout.trim().split('\n').filter(Boolean);
}

function isSummaryOnlyChanges(changedFiles) {
  return (
    Array.isArray(changedFiles) &&
    changedFiles.length > 0 &&
    changedFiles.every((file) => file === 'TESTING_SUMMARY.md')
  );
}

export function validateTestingSummary({
  summaryText,
  headSha,
  root,
  verifiedShaAncestorOfHead,
  changedFilesAfterVerified,
}) {
  const errors = [];

  if (typeof summaryText !== 'string' || summaryText.length === 0) {
    errors.push('TESTING_SUMMARY.md content is missing');
    return { ok: false, errors, shasVerified: 0, verifiedSha: null };
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

  // 3. Last verified and Last verified commit must both exist, be valid, and match each other.
  const lastVerifiedMatch = latestSection.match(/\*\*Last verified:\*\*\s*`([a-zA-Z0-9]{40})`/i);
  const lastVerifiedCommitMatch = latestSection.match(/\*\*Last verified commit:\*\*\s*`([a-zA-Z0-9]{40})`/i);

  const lastVerifiedSha = lastVerifiedMatch?.[1] ?? null;
  const lastVerifiedCommitSha = lastVerifiedCommitMatch?.[1] ?? null;

  if (!lastVerifiedSha) {
    errors.push('TESTING_SUMMARY.md latest section is missing "Last verified" SHA');
  }
  if (!lastVerifiedCommitSha) {
    errors.push('TESTING_SUMMARY.md latest section is missing "Last verified commit" SHA');
  }
  if (lastVerifiedSha && lastVerifiedCommitSha && lastVerifiedSha.toLowerCase() !== lastVerifiedCommitSha.toLowerCase()) {
    errors.push(
      `TESTING_SUMMARY.md "Last verified" (${lastVerifiedSha}) and "Last verified commit" (${lastVerifiedCommitSha}) must match`
    );
  }

  const verifiedSha = lastVerifiedSha || lastVerifiedCommitSha;

  // 4. Verified SHA must exist in git history and be an ancestor of HEAD.
  if (verifiedSha) {
    if (!/^[0-9a-f]{40}$/i.test(verifiedSha)) {
      errors.push(`TESTING_SUMMARY.md Last verified commit is not a valid 40-char SHA: ${verifiedSha}`);
    } else if (headSha && shaExists(verifiedSha, root, errors)) {
      if (typeof verifiedShaAncestorOfHead === 'boolean') {
        if (!verifiedShaAncestorOfHead) {
          errors.push(
            `TESTING_SUMMARY.md Last verified commit (${verifiedSha}) is not an ancestor of current HEAD (${headSha})`
          );
        }
      } else {
        isAncestorOfHead(verifiedSha, headSha, root, errors);
      }
    }
  }

  // 5. Any changes after the verified SHA must be strictly TESTING_SUMMARY.md.
  if (verifiedSha && headSha) {
    const changedFiles =
      changedFilesAfterVerified !== undefined
        ? changedFilesAfterVerified
        : getChangedFilesAfterVerified(root, verifiedSha, headSha);

    if (changedFiles && changedFiles.length > 0 && !isSummaryOnlyChanges(changedFiles)) {
      const nonSummary = changedFiles.filter((file) => file !== 'TESTING_SUMMARY.md');
      errors.push(
        `Non-summary files changed after Last verified commit (${verifiedSha}): ${nonSummary.join(', ')}`
      );
    }
  }

  // 6. Every full 40-char SHA in the latest verification section exists in git history.
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

  // 7. No debug marker usage as actual logs in the latest verification section.
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

  // 8. Product verification workflow remains manual-only.
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

  // 9. package.json has required scripts.
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

  return { ok: errors.length === 0, errors, shasVerified, verifiedSha };
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
  const headSha = getHeadSha(root);
  const result = validateTestingSummary({
    summaryText,
    headSha,
    root,
  });

  if (!result.ok) {
    console.error('TESTING_SUMMARY verification failed:');
    for (const err of result.errors) {
      console.error(`  - ${err}`);
    }
    process.exit(1);
  }

  console.log('TESTING_SUMMARY verification passed.');
  console.log(`  - current HEAD: ${headSha}`);
  console.log(`  - Last verified commit: ${result.verifiedSha}`);
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

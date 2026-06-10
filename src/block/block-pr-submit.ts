import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve, normalize } from 'node:path';
import { tmpdir } from 'node:os';
import type { BlockDefinition, BlockState } from './block-types.js';
import { loadBlockState, getBlockRunDir } from './block-state-manager.js';
import { loadBlockDefinition } from './block-loader.js';
import { generateBlockApprovalReport, isPathInside } from './block-approval-report.js';
import { generateBlockPrDraft } from './block-pr-draft.js';
import { createBlockPullRequest } from './block-pr-create.js';
import { getBlockPrStatus } from './block-pr-status.js';
import { redactReviewerText } from '../reviewer/reviewer-redaction.js';

export interface BlockPrSubmitResult {
  block_id: string;
  dry_run: boolean;
  pr_created: boolean;
  pr_number: number | null;
  pr_url: string | null;
  approval_report_path: string;
  draft_dir: string;
  title: string;
  body_path: string;
  pr_status_checked: boolean;
  pr_status_source_mode?: 'github_api' | 'mock';
  blocking_issues: string[];
  safety_findings: string[];
  output_path: string;
}

export interface SubmitBlockPrInput {
  blockDefinitionPath: string;
  dryRun?: boolean;
  fetchFn?: typeof fetch;
  outputDir?: string;
}

function getEnv(name: string): string | undefined {
  return process.env[name]?.trim();
}

function redactAll(input: string): string {
  return redactReviewerText(input);
}

interface ReportInput {
  blockId: string;
  blockDefinition: BlockDefinition;
  blockState: BlockState;
  dryRun: boolean;
  approvalReportPath: string;
  draftDir: string;
  title: string;
  bodyPath: string;
  prCreated: boolean;
  prNumber: number | null;
  prUrl: string | null;
  prStatusChecked: boolean;
  prStatusSourceMode?: 'github_api' | 'mock';
  blockingIssues: string[];
  safetyFindings: string[];
}

function buildSubmitReport(input: ReportInput): string {
  const lines: string[] = [];
  lines.push('# PR Submit Report');
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  lines.push(`- **Block ID:** ${input.blockId}`);
  lines.push(`- **Mode:** ${input.dryRun ? 'dry-run' : 'real'}`);
  lines.push(`- **Approval report:** ${input.approvalReportPath}`);
  lines.push(`- **PR draft dir:** ${input.draftDir}`);
  lines.push(`- **PR title:** ${input.title}`);
  lines.push(`- **PR body:** ${input.bodyPath}`);
  lines.push(`- **Draft PR created:** ${input.prCreated ? 'yes' : 'no'}`);
  if (input.prNumber !== null) {
    lines.push(`- **PR number:** ${input.prNumber}`);
  }
  if (input.prUrl !== null) {
    lines.push(`- **PR URL:** ${input.prUrl}`);
  }
  lines.push(`- **PR status checked:** ${input.prStatusChecked ? 'yes' : 'no'}`);
  if (input.prStatusChecked && input.prStatusSourceMode) {
    lines.push(`- **PR status source:** ${input.prStatusSourceMode}`);
  }
  lines.push(`- **Timestamp:** ${new Date().toISOString()}`);
  lines.push('');

  if (input.blockingIssues.length > 0) {
    lines.push('## Blocking issues');
    lines.push('');
    for (const issue of input.blockingIssues) {
      lines.push(`- ${issue}`);
    }
    lines.push('');
  }

  if (input.safetyFindings.length > 0) {
    lines.push('## Safety findings');
    lines.push('');
    for (const finding of input.safetyFindings) {
      lines.push(`- ${finding}`);
    }
    lines.push('');
  }

  lines.push('## Hard safety statements');
  lines.push('');
  lines.push('- No merge was performed.');
  lines.push('- No auto-merge was performed.');
  lines.push('- No main branch touch occurred.');
  lines.push('- No checkout or branch switch occurred.');
  lines.push('- No force push was performed.');
  lines.push('- No provider call was made.');
  lines.push('- No PR update/close/comment/review was performed.');
  lines.push('- PR creation, if performed, was draft-only.');
  lines.push('');

  return lines.join('\n');
}

export async function submitBlockPr(input: SubmitBlockPrInput): Promise<BlockPrSubmitResult> {
  const allowSubmit = getEnv('ALLOW_BLOCK_PR_SUBMIT') === 'true';
  if (!allowSubmit) {
    throw new Error('ALLOW_BLOCK_PR_SUBMIT=true is required');
  }

  let isDryRun = true;
  const envDryRun = getEnv('BLOCK_PR_SUBMIT_DRY_RUN');
  if (input.dryRun !== undefined) {
    isDryRun = input.dryRun;
  } else if (envDryRun === 'false') {
    isDryRun = false;
  } else if (envDryRun === 'true') {
    isDryRun = true;
  }

  const blockDefinition = loadBlockDefinition(input.blockDefinitionPath);
  const blockId = blockDefinition.block_id;

  const blockState = loadBlockState(blockId);
  if (!blockState) {
    throw new Error(`Block state not found: ${blockId}`);
  }

  const blockingIssues: string[] = [];
  const safetyFindings: string[] = [];

  if (blockState.status !== 'completed') {
    throw new Error('Block status must be completed to submit PR');
  }
  if (blockState.current_task_id !== null) {
    throw new Error('Current task must be null to submit PR');
  }

  const requirePrReady = getEnv('BLOCK_PR_SUBMIT_REQUIRE_PR_READY') !== 'false';

  const approvalReportResult = generateBlockApprovalReport({
    blockDefinitionPath: input.blockDefinitionPath,
  });

  if (!approvalReportResult.pr_ready && requirePrReady) {
    throw new Error(`Block is not PR-ready: ${approvalReportResult.safety_findings.join('; ')}`);
  }

  const draftResult = generateBlockPrDraft({
    blockDefinitionPath: input.blockDefinitionPath,
  });

  if (!draftResult.pr_ready && requirePrReady) {
    throw new Error('PR draft indicates block is not PR-ready');
  }

  if (blockDefinition.work_branch === 'main' || blockDefinition.work_branch === 'master') {
    throw new Error('Work branch cannot be main or master');
  }

  let prCreatedResult: Awaited<ReturnType<typeof createBlockPullRequest>> | null = null;
  let prStatusResult: Awaited<ReturnType<typeof getBlockPrStatus>> | null = null;

  if (!isDryRun) {
    prCreatedResult = await createBlockPullRequest({
      blockDefinitionPath: input.blockDefinitionPath,
      draftDir: draftResult.output_dir,
      dryRun: false,
      fetchFn: input.fetchFn,
    });

    const allowStatus = getEnv('ALLOW_GITHUB_PR_STATUS') === 'true';
    if (allowStatus && prCreatedResult.pr_created && prCreatedResult.pr_number) {
      try {
        prStatusResult = await getBlockPrStatus({
          blockDefinitionPath: input.blockDefinitionPath,
          prNumber: prCreatedResult.pr_number,
          fetchFn: input.fetchFn,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        safetyFindings.push(`PR status check failed: ${message}`);
      }
    }
  } else {
    try {
      await createBlockPullRequest({
        blockDefinitionPath: input.blockDefinitionPath,
        draftDir: draftResult.output_dir,
        dryRun: true,
        fetchFn: input.fetchFn,
      });
      safetyFindings.push('Dry-run: PR create validation passed');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Dry-run PR create validation failed: ${message}`);
    }
  }

  const title = readFileSync(join(draftResult.output_dir, 'pr-title.txt'), 'utf-8');

  const runDir = getBlockRunDir(blockId);
  const outputDir = input.outputDir ?? join(runDir, 'pr-submit');
  const resolvedOutputDir = resolve(normalize(outputDir));
  const cwdResolved = resolve(normalize(process.cwd()));
  const runsDirResolved = resolve(normalize(join(process.cwd(), 'runs')));
  const tmpDirResolved = resolve(normalize(tmpdir()));
  const allowedBases = [runsDirResolved, cwdResolved, tmpDirResolved];
  const isAllowed = allowedBases.some(
    (base) => isPathInside(base, resolvedOutputDir) || resolve(base) === resolve(resolvedOutputDir)
  );
  if (!isAllowed) {
    throw new Error('Output directory is outside allowed directory');
  }
  if (!existsSync(outputDir)) {
    mkdirSync(outputDir, { recursive: true });
  }

  const outputPath = join(outputDir, 'pr-submit-report.md');

  const report = buildSubmitReport({
    blockId,
    blockDefinition,
    blockState,
    dryRun: isDryRun,
    approvalReportPath: approvalReportResult.output_path,
    draftDir: draftResult.output_dir,
    title,
    bodyPath: draftResult.body_path,
    prCreated: prCreatedResult?.pr_created ?? false,
    prNumber: prCreatedResult?.pr_number ?? null,
    prUrl: prCreatedResult?.pr_url ?? null,
    prStatusChecked: !!prStatusResult,
    prStatusSourceMode: prStatusResult?.source_mode,
    blockingIssues,
    safetyFindings,
  });

  const redactedReport = redactAll(report);
  writeFileSync(outputPath, redactedReport, 'utf-8');

  return {
    block_id: blockId,
    dry_run: isDryRun,
    pr_created: prCreatedResult?.pr_created ?? false,
    pr_number: prCreatedResult?.pr_number ?? null,
    pr_url: prCreatedResult?.pr_url ?? null,
    approval_report_path: approvalReportResult.output_path,
    draft_dir: draftResult.output_dir,
    title,
    body_path: draftResult.body_path,
    pr_status_checked: !!prStatusResult,
    pr_status_source_mode: prStatusResult?.source_mode,
    blocking_issues: blockingIssues,
    safety_findings: safetyFindings,
    output_path: outputPath,
  };
}

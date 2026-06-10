import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve, normalize } from 'node:path';
import { sync as spawnSync } from 'cross-spawn';
import { loadBlockDefinition } from './block-loader.js';
import { getBlockRunDir } from './block-state-manager.js';

export interface BlockSandboxInput {
  blockDefinitionPath: string;
  outputPath?: string;
  sandboxPath?: string;
  baseRef?: string;
  keep?: boolean;
  runCommand?: (
    cwd: string,
    command: string,
    args: string[]
  ) => { stdout: string; stderr: string; status: number | null };
}

export interface BlockSandboxResult {
  block_id: string;
  base_branch: string;
  base_commit: string;
  sandbox_path: string;
  commands_executed: string[];
  typecheck_result: 'pass' | 'fail';
  build_result: 'pass' | 'fail';
  test_result: 'pass' | 'fail';
  main_status_before: string;
  main_status_after: string;
  sandbox_status: string;
  cleanup_result: 'success' | 'failed' | 'skipped';
  safety_findings: string[];
  blocking_issues: string[];
  output_path: string;
}

function defaultRunCommand(
  cwd: string,
  command: string,
  args: string[]
): { stdout: string; stderr: string; status: number | null } {
  const result = spawnSync(command, args, {
    cwd,
    shell: false,
    encoding: 'utf-8',
  });
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    status: result.status,
  };
}

function validateOutputPath(outputPath: string, blockId: string): string {
  const resolved = resolve(normalize(outputPath));
  const runsDir = resolve(normalize(join(process.cwd(), 'runs')));
  if (!resolved.startsWith(runsDir)) {
    throw new Error('Output path must be inside runs directory');
  }
  return resolved;
}

function redact(text: string): string {
  return text
    .replace(/ghp_[a-zA-Z0-9]{36,}/g, '[REDACTED]')
    .replace(/github_pat_[a-zA-Z0-9_]{22,}/g, '[REDACTED]')
    .replace(/sk-[a-zA-Z0-9]{48,}/g, '[REDACTED]')
    .replace(/Bearer\s+[a-zA-Z0-9_-]+/g, 'Bearer [REDACTED]');
}

export function runBlockSandbox(input: BlockSandboxInput): BlockSandboxResult {
  const run = input.runCommand ?? defaultRunCommand;

  // 1. Gate
  if (process.env.ALLOW_BLOCK_SANDBOX?.trim() !== 'true') {
    throw new Error(
      'Sandbox execution is blocked. Set ALLOW_BLOCK_SANDBOX=true to enable.'
    );
  }

  // 2. Load block definition
  const definition = loadBlockDefinition(input.blockDefinitionPath);
  const blockId = definition.block_id;
  const repoPath = resolve(definition.repo_path);

  // 3. Verify main repo clean before sandbox
  const mainStatusBeforeResult = run(repoPath, 'git', ['status', '--porcelain']);
  const mainStatusBefore = mainStatusBeforeResult.status === 0
    ? mainStatusBeforeResult.stdout.trim()
    : '';
  if (mainStatusBefore.length > 0) {
    throw new Error(
      'Working tree is not clean. Commit or stash changes first.'
    );
  }

  // 4. Determine base ref and commit
  const baseRef =
    input.baseRef?.trim() ||
    run(repoPath, 'git', ['rev-parse', '--abbrev-ref', 'HEAD']).stdout.trim();

  const baseCommitResult = run(repoPath, 'git', ['rev-parse', 'HEAD']);
  const baseCommit = baseCommitResult.stdout.trim();

  // 5. Determine sandbox path
  const defaultSandboxPath = join(
    process.cwd(),
    'tmp',
    'block-sandbox',
    blockId
  );
  const sandboxPath = input.sandboxPath
    ? resolve(normalize(input.sandboxPath))
    : defaultSandboxPath;

  // Ensure sandbox path is not inside repoPath
  const resolvedRepo = resolve(repoPath);
  const resolvedSandbox = resolve(sandboxPath);
  if (
    resolvedSandbox === resolvedRepo ||
    resolvedSandbox.startsWith(resolvedRepo + normalize('/'))
  ) {
    throw new Error(
      'Sandbox path must not be inside the source repository'
    );
  }

  // 6. Create worktree
  const addResult = run(repoPath, 'git', [
    'worktree',
    'add',
    sandboxPath,
    baseRef,
  ]);
  if (addResult.status !== 0) {
    throw new Error(
      `git worktree add failed: ${redact(addResult.stderr)}`
    );
  }

  // 7. Run checks inside sandbox
  const commandsExecuted: string[] = [];
  const logs: Record<string, string> = {};

  function runCheck(name: string, command: string, args: string[]): boolean {
    commandsExecuted.push(`${command} ${args.join(' ')}`);
    const result = run(sandboxPath, command, args);
    logs[name] = result.stdout + result.stderr;
    return result.status === 0;
  }

  const typecheckOk = runCheck('typecheck', 'npm', ['run', 'typecheck']);
  const buildOk = runCheck('build', 'npm', ['run', 'build']);
  const testOk = runCheck('test', 'npm', ['test']);

  // 8. Collect statuses
  const sandboxStatusResult = run(sandboxPath, 'git', ['status', '--porcelain']);
  const sandboxStatus = sandboxStatusResult.stdout.trim();

  const mainStatusAfterResult = run(repoPath, 'git', ['status', '--porcelain']);
  const mainStatusAfter = mainStatusAfterResult.stdout.trim();

  // 9. Cleanup
  const keep =
    input.keep === true || process.env.BLOCK_SANDBOX_KEEP?.trim() === 'true';

  let cleanupResult: 'success' | 'failed' | 'skipped';
  if (!keep) {
    const removeResult = run(repoPath, 'git', [
      'worktree',
      'remove',
      sandboxPath,
    ]);
    cleanupResult = removeResult.status === 0 ? 'success' : 'failed';
  } else {
    cleanupResult = 'skipped';
  }

  // 10. Safety findings and blocking issues
  const safetyFindings: string[] = [];
  const blockingIssues: string[] = [];

  if (mainStatusAfter.length > 0) {
    safetyFindings.push('Main working tree changed during sandbox execution');
  }
  if (!typecheckOk) blockingIssues.push('typecheck failed');
  if (!buildOk) blockingIssues.push('build failed');
  if (!testOk) blockingIssues.push('tests failed');

  // 11. Report
  const reportDir = join(getBlockRunDir(blockId), 'sandbox');
  mkdirSync(reportDir, { recursive: true });

  const outputPath = input.outputPath
    ? validateOutputPath(input.outputPath, blockId)
    : join(reportDir, 'sandbox-report.md');

  const reportLines = [
    '# Block Sandbox Report',
    '',
    `- Block ID: ${blockId}`,
    `- Base branch: ${baseRef}`,
    `- Base commit: ${baseCommit}`,
    `- Sandbox path: ${sandboxPath}`,
    `- Commands executed:`,
    ...commandsExecuted.map((c) => `  - ${c}`),
    `- Type check: ${typecheckOk ? 'pass' : 'fail'}`,
    `- Build: ${buildOk ? 'pass' : 'fail'}`,
    `- Tests: ${testOk ? 'pass' : 'fail'}`,
    `- Main status before: ${mainStatusBefore.length === 0 ? 'clean' : 'dirty'}`,
    `- Main status after: ${mainStatusAfter.length === 0 ? 'clean' : 'dirty'}`,
    `- Sandbox status: ${sandboxStatus.length === 0 ? 'clean' : 'dirty'}`,
    `- Cleanup: ${cleanupResult}`,
    `- Safety findings: ${safetyFindings.length > 0 ? safetyFindings.join('; ') : 'none'}`,
    `- Blocking issues: ${blockingIssues.length > 0 ? blockingIssues.join('; ') : 'none'}`,
    '',
    '## Command logs',
    '',
    '### typecheck',
    '```',
    redact(logs['typecheck'] || ''),
    '```',
    '',
    '### build',
    '```',
    redact(logs['build'] || ''),
    '```',
    '',
    '### test',
    '```',
    redact(logs['test'] || ''),
    '```',
  ];

  writeFileSync(outputPath, reportLines.join('\n'), 'utf-8');

  return {
    block_id: blockId,
    base_branch: baseRef,
    base_commit: baseCommit,
    sandbox_path: sandboxPath,
    commands_executed: commandsExecuted,
    typecheck_result: typecheckOk ? 'pass' : 'fail',
    build_result: buildOk ? 'pass' : 'fail',
    test_result: testOk ? 'pass' : 'fail',
    main_status_before: mainStatusBefore.length === 0 ? 'clean' : 'dirty',
    main_status_after: mainStatusAfter.length === 0 ? 'clean' : 'dirty',
    sandbox_status: sandboxStatus.length === 0 ? 'clean' : 'dirty',
    cleanup_result: cleanupResult,
    safety_findings: safetyFindings,
    blocking_issues: blockingIssues,
    output_path: outputPath,
  };
}

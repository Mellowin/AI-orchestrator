import { describe, test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildContext } from '../src/context-builder.js';
import { buildKimiPrompt } from '../src/prompt-builder.js';
import { buildReviewerInput } from '../src/reviewer-input.js';
import { buildReviewerPrompt } from '../src/reviewer/reviewer-prompt.js';
import { buildFixTaskPrompt } from '../src/reviewer-fix-task-real-executor.js';
import { buildSingleTaskYaml, buildTaskExecutorInput } from '../src/task-executor-input.js';
import type { BlockDefinition, BlockTaskDefinition } from '../src/block/block-types.js';
import type { DependencyEvidencePackage, Task } from '../src/types.js';
import type { ReviewerEvidence } from '../src/reviewer-evidence.js';
import type { ReviewInput } from '../src/providers/provider-types.js';
import type { ReviewerFixTaskExecutorInput } from '../src/reviewer-fix-task-runner.js';

function makeDependencyEvidence(): DependencyEvidencePackage {
  return {
    items: [
      {
        task_id: 'ancestor-1',
        task_status: 'accepted',
        accepted_commit_sha: 'a'.repeat(40),
        path: 'src/ancestor.ts',
        content_sha256: 'b'.repeat(64),
        bytes: 42,
        lines: 3,
        content: 'export const ancestor = 1;\n',
        truncated: false,
      },
    ],
    total_bytes: 42,
    truncated: false,
    omitted_count: 0,
  };
}

function makeBlock(overrides?: Partial<BlockDefinition>): BlockDefinition {
  return {
    block_id: 'block-1',
    title: 'Test Block',
    repo_path: '/tmp/fake-repo',
    base_branch: 'main',
    work_branch: 'ai/block-1',
    providers: {
      coder: { provider: 'fake', model: 'fake' },
      reviewer: { provider: 'fake', model: 'fake' },
    },
    review_policy: {
      require_deterministic_checks: false,
      max_fix_attempts: 1,
      reviewer_mode: 'single',
    },
    tasks: [],
    ...overrides,
  };
}

function makeBlockTask(overrides?: Partial<BlockTaskDefinition>): BlockTaskDefinition {
  return {
    task_id: 'task-1',
    title: 'Test Task',
    goal: 'Test goal',
    allowed_files: ['src/index.ts'],
    denied_files: ['.env'],
    max_lines_changed: 100,
    checks: [],
    ...overrides,
  };
}

function makeTask(overrides?: Partial<Task>): Task {
  return {
    id: 'task-1',
    title: 'Test Task',
    repo_path: '/tmp/fake-repo',
    base_branch: 'main',
    work_branch: 'ai/task-1',
    goal: 'Test goal',
    context_files: [],
    checks: [],
    guardrails: {
      deny_modify: ['.env'],
      auto_commit: false,
      auto_push: false,
      auto_merge: false,
    },
    ...overrides,
  };
}

function makeReviewerEvidence(overrides?: Partial<ReviewerEvidence>): ReviewerEvidence {
  return {
    taskId: 'task-1',
    taskGoal: 'Test goal',
    repoPath: '/tmp/repo',
    branchName: 'ai/task-1',
    commitSha: 'a'.repeat(40),
    shortCommitSha: 'aaaaaaa',
    changedFiles: ['src/index.ts'],
    diffStat: ' 1 file changed, 1 insertion(+)',
    commitExists: true,
    checkSummary: { test: 'pass' },
    safety: {
      commitShaIsFullLength: true,
      branchIsNotMain: true,
      hasChangedFiles: true,
    },
    ...overrides,
  };
}

function makeReviewInput(overrides?: Partial<ReviewInput>): ReviewInput {
  return {
    task_id: 'task-1',
    task_title: 'Test Task',
    task_goal: 'Test goal',
    repo_path: '/tmp/repo',
    allowed_files: ['src/index.ts'],
    denied_files: ['.env'],
    max_lines_changed: 100,
    commit_sha: 'a'.repeat(40),
    changed_files: ['src/index.ts'],
    diff: '+line\n',
    typecheck_result: 'pass',
    build_result: 'pass',
    test_result: 'pass',
    git_status: '',
    safety_findings: [],
    ...overrides,
  };
}

describe('dependency evidence flow', () => {
  test('buildSingleTaskYaml debug artifact preserves dependency_evidence', () => {
    const evidence = makeDependencyEvidence();
    const block = makeBlock();
    const task = makeBlockTask({ dependency_evidence: evidence });
    const yaml = buildSingleTaskYaml(block, task);
    const parsed = JSON.parse(yaml);
    assert.deepStrictEqual(parsed.tasks[0].dependency_evidence, evidence);
  });

  test('buildTaskExecutorInput preserves the same dependency_evidence as debug YAML', () => {
    const evidence = makeDependencyEvidence();
    const block = makeBlock();
    const task = makeBlockTask({ dependency_evidence: evidence });

    const yaml = buildSingleTaskYaml(block, task);
    const yamlParsed = JSON.parse(yaml);

    const input = buildTaskExecutorInput(block, task, {
      taskBaseSha: 'a'.repeat(40),
      candidatePath: '/tmp/candidate',
      runId: 'run-1',
    });

    assert.deepStrictEqual(input.task.dependency_evidence, evidence);
    assert.deepStrictEqual(input.task.dependency_evidence, yamlParsed.tasks[0].dependency_evidence);
  });

  test('buildReviewerInput preserves dependency_evidence', () => {
    const evidence = makeDependencyEvidence();
    const reviewerInput = buildReviewerInput(makeReviewerEvidence({ dependencyEvidence: evidence }));
    assert.deepStrictEqual(reviewerInput.dependency_evidence, evidence);
  });

  test('buildReviewerInput omits dependency_evidence when evidence has none', () => {
    const reviewerInput = buildReviewerInput(makeReviewerEvidence());
    assert.strictEqual(reviewerInput.dependency_evidence, undefined);
  });

  test('buildContext passes dependency_evidence to ContextPackage', () => {
    const evidence = makeDependencyEvidence();
    const repo = mkdtempSync(join(tmpdir(), 'dep-ctx-repo-'));
    try {
      writeFileSync(join(repo, 'a.txt'), 'A', 'utf-8');
      const task = makeTask({ repo_path: repo, context_files: ['a.txt'], dependency_evidence: evidence });
      const context = buildContext(task);
      assert.deepStrictEqual(context.dependency_evidence, evidence);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test('buildKimiPrompt includes Dependency Evidence section when evidence is present', () => {
    const evidence = makeDependencyEvidence();
    const repo = mkdtempSync(join(tmpdir(), 'dep-prompt-repo-'));
    try {
      writeFileSync(join(repo, 'a.txt'), 'A', 'utf-8');
      const task = makeTask({ repo_path: repo, context_files: ['a.txt'], dependency_evidence: evidence });
      const prompt = buildKimiPrompt(buildContext(task));
      assert.ok(prompt.includes('# Dependency Evidence (read-only)'), 'Expected dependency evidence section');
      assert.ok(prompt.includes('src/ancestor.ts'), 'Expected ancestor file path');
      assert.ok(prompt.includes('export const ancestor = 1;'), 'Expected ancestor content');
      assert.ok(
        prompt.includes('You may NOT modify them') || prompt.includes('read-only'),
        'Expected read-only instruction'
      );
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test('buildKimiPrompt does not include Dependency Evidence section when evidence is absent', () => {
    const repo = mkdtempSync(join(tmpdir(), 'dep-prompt-repo-'));
    try {
      writeFileSync(join(repo, 'a.txt'), 'A', 'utf-8');
      const task = makeTask({ repo_path: repo, context_files: ['a.txt'] });
      const prompt = buildKimiPrompt(buildContext(task));
      assert.ok(!prompt.includes('# Dependency Evidence'), 'Should not include dependency evidence section');
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test('buildKimiPrompt constraint reminds coder that dependency evidence is read-only', () => {
    const evidence = makeDependencyEvidence();
    const repo = mkdtempSync(join(tmpdir(), 'dep-prompt-repo-'));
    try {
      writeFileSync(join(repo, 'a.txt'), 'A', 'utf-8');
      const task = makeTask({ repo_path: repo, context_files: ['a.txt'], dependency_evidence: evidence });
      const context = buildContext(task);
      const constraint = context.constraints.find((c) => c.includes('Dependency evidence'));
      assert.ok(constraint, 'Expected read-only dependency evidence constraint');
      assert.ok(constraint.includes('read-only'), 'Constraint should mention read-only');
      assert.ok(constraint.includes('write scope'), 'Constraint should remind about write scope');
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test('buildReviewerPrompt includes dependency evidence and read-only rules', () => {
    const evidence = makeDependencyEvidence();
    const prompt = buildReviewerPrompt(makeReviewInput({ dependency_evidence: evidence }));
    assert.ok(prompt.includes('## Dependency Evidence (read-only context from accepted ancestor tasks)'), 'Expected dependency evidence section');
    assert.ok(prompt.includes('src/ancestor.ts'), 'Expected ancestor file path');
    assert.ok(prompt.includes('Do NOT request changes to dependency files'), 'Expected read-only rule');
    assert.ok(prompt.includes('A fix task may modify ONLY the current task allowed_files'), 'Expected fix coder scope rule');
  });

  test('buildReviewerPrompt does not invent dependency evidence when absent', () => {
    const prompt = buildReviewerPrompt(makeReviewInput());
    assert.ok(!prompt.includes('## Dependency Evidence'), 'Should not include dependency evidence section');
  });

  test('buildFixTaskPrompt includes dependency evidence and read-only scope', () => {
    const evidence = makeDependencyEvidence();
    const input: ReviewerFixTaskExecutorInput = {
      executionRequest: {
        kind: 'ready',
        taskId: 'fix-task-1',
        parentTaskId: 'task-1',
        attempt: 1,
        title: 'Fix Task',
        goal: 'Fix the issue',
        blockingIssues: ['missing test'],
        source: 'reviewer',
      } as unknown as ReviewerFixTaskExecutorInput['executionRequest'],
      fixTask: {
        taskId: 'fix-task-1',
        parentTaskId: 'task-1',
        attempt: 1,
        title: 'Fix Task',
        goal: 'Fix the issue',
        source: 'reviewer',
        blockingIssues: ['missing test'],
      },
      taskId: 'fix-task-1',
      parentTaskId: 'task-1',
      attempt: 1,
      title: 'Fix Task',
      goal: 'Fix the issue',
      blockingIssues: ['missing test'],
    };

    const prompt = buildFixTaskPrompt(input, {
      parentGoal: 'Parent goal',
      allowedFiles: ['src/index.ts'],
      deniedFiles: ['.env'],
      previousChangedFiles: ['src/index.ts'],
      checks: [{ command: 'npm', args: ['test'] }],
      currentHead: 'a'.repeat(40),
      dependencyEvidence: evidence,
    });

    assert.ok(prompt.includes('# Dependency Evidence (read-only context from accepted ancestor tasks)'), 'Expected dependency evidence section');
    assert.ok(prompt.includes('src/ancestor.ts'), 'Expected ancestor file path');
    assert.ok(prompt.includes('Do not modify files outside allowed scope'), 'Expected allowed scope reminder');
  });
});

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { deriveReviewerTaskOutcome } from '../src/reviewer-task-outcome.js';
import { deriveReviewerTaskTransition, type ReviewerTaskTransition } from '../src/reviewer-task-transition.js';
import { deriveReviewerTaskDecision } from '../src/reviewer-task-decision.js';
import { deriveReviewerBlockActionPlan, type ReviewerBlockActionPlan } from '../src/reviewer-block-action-plan.js';
import { deriveReviewerBlockDecision } from '../src/reviewer-block-decision.js';
import { deriveReviewerFixTaskPlan } from '../src/reviewer-fix-task-plan.js';
import { deriveReviewerBlockResolutionPlan } from '../src/reviewer-block-resolution-plan.js';
import { deriveReviewerBlockReviewResult } from '../src/reviewer-block-review-result.js';
import * as blockActionPlan from '../src/reviewer-block-action-plan.js';
import type { RunState } from '../src/types.js';

describe('reviewer module boundaries', () => {
  it('imports deriveReviewerTaskOutcome from reviewer-task-outcome', () => {
    assert.equal(typeof deriveReviewerTaskOutcome, 'function');
  });

  it('imports deriveReviewerTaskTransition from reviewer-task-transition', () => {
    assert.equal(typeof deriveReviewerTaskTransition, 'function');
  });

  it('imports deriveReviewerTaskDecision from reviewer-task-decision', () => {
    assert.equal(typeof deriveReviewerTaskDecision, 'function');
  });

  it('imports deriveReviewerBlockActionPlan from reviewer-block-action-plan', () => {
    assert.equal(typeof deriveReviewerBlockActionPlan, 'function');
  });

  it('imports deriveReviewerBlockDecision from reviewer-block-decision', () => {
    assert.equal(typeof deriveReviewerBlockDecision, 'function');
  });

  it('imports deriveReviewerFixTaskPlan from reviewer-fix-task-plan', () => {
    assert.equal(typeof deriveReviewerFixTaskPlan, 'function');
  });

  it('imports deriveReviewerBlockResolutionPlan from reviewer-block-resolution-plan', () => {
    assert.equal(typeof deriveReviewerBlockResolutionPlan, 'function');
  });

  it('imports deriveReviewerBlockReviewResult from reviewer-block-review-result', () => {
    assert.equal(typeof deriveReviewerBlockReviewResult, 'function');
  });

  it('imports ReviewerTaskTransition type from reviewer-task-transition', () => {
    const transition: ReviewerTaskTransition = {
      action: 'continue',
      reason: 'boundary test',
    };
    assert.equal(transition.action, 'continue');
  });

  it('imports ReviewerBlockActionPlan type from reviewer-block-action-plan', () => {
    const plan: ReviewerBlockActionPlan = {
      blockId: 'boundary-test',
      action: 'continue',
      reason: 'boundary test',
      sourceTaskDecision: undefined,
    };
    assert.equal(plan.action, 'continue');
  });

  it('does not export ReviewerTaskTransition from reviewer-block-action-plan', () => {
    assert.equal('ReviewerTaskTransition' in blockActionPlan, false);
  });

  it('calls deriveReviewerBlockReviewResult for a pushed task without reviewer_gate and resolves to continue_block', () => {
    const runState: RunState = {
      task_id: 'boundary-task-1',
      status: 'pushed',
      started_at: '2026-06-11T12:00:00Z',
      updated_at: '2026-06-11T12:00:00Z',
      repo_path: '/tmp/boundary',
      branch: 'boundary',
      base_branch: 'main',
      work_branch: 'boundary',
      attempt: 1,
      commit_sha: null,
    };

    const result = deriveReviewerBlockReviewResult({
      blockId: 'boundary-block',
      tasks: [
        {
          taskId: 'boundary-task-1',
          taskTitle: 'Boundary task',
          taskGoal: 'Prove boundary imports work',
          runState,
        },
      ],
      existingFixAttemptsByParentTaskId: {},
      maxFixAttempts: 3,
    });

    assert.equal(result.blockId, 'boundary-block');
    assert.equal(result.resolutionPlan.action, 'continue_block');
  });
});

# STAGE 18.26 — Proof 11 Part 3

## Continuation from Part 2

This document extends the argument established in [STAGE_18_26_PROOF11_PART2.md](STAGE_18_26_PROOF11_PART2.md). Part 2 derived the intermediate invariants and showed that the transition relation preserves the safety property under the bounded scheduler. In this part we close the remaining gap: demonstrating that the invariant holds at every reachable state after the refinement step introduced in Stage 18.26.

## Goal

Establish that the composed system `S' = S || R` satisfies the guarded liveness property `G` for all traces consistent with the Stage 18.26 execution model.

## Definitions

- Let `S` be the abstract system described in Part 1.
- Let `R` be the refinement layer validated in Part 2.
- Let `I` be the inductive invariant `I = I_S ∧ I_R ∧ I_link` from Part 2.
- Let `G` be the target liveness property: every pending request is eventually acknowledged or canceled.

## Proof Strategy

We prove `S' ⊨ G` by the following three lemmas. Each lemma is proved independently and then composed.

### Lemma 1 — Request Persistence

If a request `req` is issued at state `σ_k` and remains pending, then either:

1. it is eventually acknowledged by some state `σ_m` with `m > k`, or
2. it is explicitly canceled by the originator or a timeout handler.

**Proof.** By the transition relation `T_R` of the refinement layer, every pending request is appended to a FIFO queue `Q`. The dispatcher removes the head of `Q` and either produces an acknowledgment or, if the request violates a guard, emits a cancel event. Fairness of the dispatcher (assumption A2) guarantees that the head is eventually removed. Therefore every request follows path (1) or (2).

### Lemma 2 — No Infinite Stuttering

The system `S'` does not contain an infinite sequence of stuttering steps while a request remains pending.

**Proof.** Stuttering steps are only allowed when the pending set is empty (definition of the idle transition `T_idle`). If a request is pending, the guard `G_pending` disables `T_idle`. Because `I` enforces that `G_pending` accurately reflects the queue state, no infinite stuttering trace can mask a pending request.

### Lemma 3 — Acknowledgment Monotonicity

Once a request is acknowledged or canceled, it is never re-inserted into the pending set.

**Proof.** The acknowledgment and cancel transitions are terminal in the request lifecycle. The refinement invariant `I_link` maps each abstract identifier to a unique concrete handle and asserts that `status(req) ∈ {pending, acked, canceled}` is a monotonic function. The transition relation only allows transitions from `pending` to `acked` or `canceled`, never the reverse.

## Composition

From Lemma 1 every pending request eventually leaves the pending state. From Lemma 2 this cannot be delayed indefinitely by stuttering. From Lemma 3 it leaves the pending state permanently. Therefore, for every request `req` and every trace `π` of `S'`, the set of indices `{ i | pending(req, π_i) }` is finite and bounded above by the index at which the corresponding dispatcher step occurs.

Thus, `S' ⊨ G`.

## Stage 18.26 Specific Notes

The refinement layer introduced in Stage 18.26 adds two new transitions:

- `T_batch`: processes a bounded batch of pending requests in one atomic step.
- `T_retry`: requeues a request that failed a transient guard.

Both transitions preserve `I` because:

- `T_batch` is a sequential composition of the single-request dispatcher transitions already validated in Lemma 1. The batch bound ensures the composition remains finite and does not introduce new cycles.
- `T_retry` appends the request to the tail of `Q`, preserving the FIFO order and the eventual-service guarantee. The retry counter is bounded by assumption A3, so infinite retry loops are excluded.

## Conclusion

Part 3 completes the liveness argument for Proof 11. Together with the invariant proof in Part 2 and the base model in Part 1, we have:

1. `I` is an inductive invariant of `S'` (Part 2).
2. `I` implies the absence of permanent pending requests (Part 3).
3. Therefore `S'` satisfies the guarded liveness property `G`.

## References

- Part 1: [STAGE_18_26_PROOF11_PART1.md](STAGE_18_26_PROOF11_PART1.md)
- Part 2: [STAGE_18_26_PROOF11_PART2.md](STAGE_18_26_PROOF11_PART2.md)
- Part 4 (planned): verification of the concrete implementation against `S'`.

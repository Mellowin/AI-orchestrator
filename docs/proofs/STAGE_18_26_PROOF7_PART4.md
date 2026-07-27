# STAGE_18_26 PROOF 7 – PART 4

## Lemma 4 (Completeness of the Asymptotic Bound)

For every ε > 0, there exists a finite horizon N such that
for all n ≥ N and all admissible policies π ∈ Π_adm,

  |V_n^π(s) - V^*(s)| ≤ ε · (1 + ||s||)        (1)

**Proof.** By Lemma 3, V_n^π converges uniformly on compact
sets. The Bellman optimality operator T is a contraction in
the weighted norm ||·||_w with factor γ < 1. Hence iterates
T^k V_0 satisfy (1) after choosing N = ⌈log(ε/2)/log γ⌉. ∎

## Corollary (Policy Optimality)

Any limit point π* of the sequence (π_n) produced by
Algorithm 1 is globally optimal for STAGE_18_26.
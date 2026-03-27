---
title: "SSM Foundation and Evaluation Harness"
id: ssm-foundation-evaluation
status: planning
informed_by:
  - "docs/research/technical/RESEARCH-SSM-INTEGRATION.md"
  - "docs/research/technical/SSM-LITERATURE-REVIEW.md"
  - "docs/research/technical/SYNTHETIC-DATA-GENERATION.md"
  - "docs/research/technical/ssm-implementations-survey.md"
  - "arxiv:2601.07372 (Engram: Conditional Memory via Scalable Lookup)"
section: "Predictive Scorer"
depends_on:
  - "predictive-memory-scorer"
  - "desire-paths-epic"
success_criteria:
  - "SSM candidate baseline can be trained and evaluated on reproducible benchmark suites"
  - "Canary tests prove temporal pattern learning beyond static score heuristics"
  - "Ablations compare SSM vs current scorer on MRR, NDCG@10, and temporal precision"
scope_boundary: "Defines SSM data pipeline, benchmark harness, and acceptance gates; does not replace production retrieval or scorer paths"
---

# SSM Foundation and Evaluation Harness

## 1) Problem

The predictive memory scorer (~1.11M params, cross-attention) scores
candidates independently. It cannot model sequential patterns across a
session history: which memories were accessed in what order, how relevance
shifts over a conversation, or how temporal gaps between sessions change
what matters. The existing `ssm_proof_of_concept.py` validates that a
Mamba-style selective SSM can learn planted canary patterns, but the PoC
has known issues (wrong loss function, untrained heads, unfair baseline
comparison) and no path to reproducible evaluation against the production
scorer.

This spec creates the controlled evaluation lane that turns research into
measurable experiments with stable datasets, canaries, and acceptance
thresholds, before any production routing changes.

## 2) Goals

1. Build a reproducible benchmark harness that compares SSM candidates
   against the current cross-attention scorer on identical data.
2. Construct a synthetic + real mixed training corpus with planted canary
   patterns and configurable noise levels.
3. Fix the PoC's known issues (ListNet loss, dead heads, fair baselines)
   so comparisons are architecture-to-architecture, not loss-to-loss.
4. Establish acceptance gates for promotion to shadow mode (spec:
   ssm-temporal-backbone).
5. Validate Engram-informed architectural improvements (multi-head
   hashing, parameter rebalancing) as part of the ablation matrix.

## 3) Proposed capability set

### A) Benchmark harness (`packages/predictor/bench/`)

Standalone Python harness (no daemon dependency) that:

- Loads synthetic JSONL or real session data (exported from SQLite).
- Trains both SSM and cross-attention models on identical data splits.
- Evaluates with identical metrics: HR@5, HR@10, MRR@10, DCG@10,
  Precision@K, Recall@K, latency p50/p95/p99.
- Reports per-canary-pattern pass/fail, SNR degradation curve, and
  dual-error memorization test.
- Outputs machine-readable JSON for CI consumption.

### B) PoC corrections

The existing `ssm_proof_of_concept.py` must be updated before any
conclusions are drawn:

1. **Loss function**: Replace BCE with ListNet (KL divergence over
   softmax-normalized logits with temperature). This matches the
   production scorer's `listwise_loss` and makes the comparison fair.
2. **Dead heads**: Either add supervision signals for significance,
   retention, traversal, and contradiction heads, or remove them and
   benchmark a single-head relevance model. Multi-head without
   multi-target is dead weight.
3. **Baseline parity**: The MLP baseline should also use ListNet loss.
   The heuristic baseline (`importance * 0.95^age`) stays as-is since
   it represents production behavior.

### C) Engram-informed ablations

Execution details for this lane are tracked in
`docs/specs/planning/engram-informed-predictor-track.md`.

The Engram paper (arxiv:2601.07372) identifies architectural patterns
directly relevant to the scorer. Add these to the ablation matrix:

| Ablation | What it tests | Implementation |
|----------|---------------|----------------|
| Multi-head hashing (K=2,4) | Collision reduction in HashTrick path | Split 64-dim embedding into K heads, concatenate |
| Prime bucket count (16,381) | Systematic collision reduction | Change modulo from 16,384 to 16,381 |
| NFKC + lowercase normalization | Free vocabulary reduction | Add unicode normalization before FNV-1a |
| Parameter rebalancing | U-shaped compute/memory ratio | Try 8K buckets + 128-dim internal (shift params from table to projections) |
| Separate gating | Engram-style alpha gate | Split attention score from content gate instead of single logit |
| Causal Conv1d post-gating | Local receptive field | Add depthwise Conv1d(kernel=4, SiLU) after value gating |

Each ablation runs independently against the baseline cross-attention
scorer. Report delta on all metrics.

### D) Synthetic data pipeline

Follow RESEARCH-SSM-INTEGRATION Phase 0 specification:

- 7 canary patterns (temporal cycle, recency decay, entity selectivity,
  supersession chain, burst, cross-entity dependency, combined).
- SNR levels: 30dB, 20dB, 10dB, 0dB, -10dB.
- Dual-error memorization test (MSE_True vs MSE_Obs).
- Hard negatives: entity-neighbor, temporal-neighbor, semantic-neighbor,
  superseded negatives.
- Curriculum: easy-to-hard over 4 stages per RESEARCH-SSM-INTEGRATION.

Data budget: 50K synthetic sequences for Phase 0. Real session export
added in Phase 1 (requires daemon export endpoint).

### E) Real session data export

New daemon endpoint: `GET /api/predictor/export-training-data`

- Exports training pairs from `session_scores` + `session_memories`
  as JSONL matching the benchmark harness format.
- Includes 17-dim feature vectors, labels, context embeddings.
- Agent-scoped (respects agent_id filter).
- Rate-limited, auth-required.

## 4) Non-goals

- No production replacement of the current scorer.
- No schema migration or graph topology changes.
- No Rust implementation of SSM (Python/PyTorch for evaluation only).
- No online training or shadow deployment (that's ssm-temporal-backbone).

## 5) Integration contracts

### SSM Foundation <-> Predictive Memory Scorer

- Benchmark uses identical 17-dim feature vectors from `protocol.rs`.
- Benchmark uses identical candidate pool construction (effective score
  top-50 + embedding top-50).
- Results are directly comparable because both models consume the same
  inputs and are evaluated on the same metric suite.

### SSM Foundation <-> Desire Paths

- Benchmark includes multi-hop retrieval test cases from DP-6 benchmark
  suite (the 50-question LoCoMo set).
- Path-level features (hop count, edge confidence) reserved for
  ssm-graph-traversal-model, not used here.

## 6) Rollout phases

### Phase 1: Harness + PoC fixes

- Fix ssm_proof_of_concept.py (ListNet loss, dead heads, fair baselines).
- Build benchmark harness with synthetic data pipeline.
- Run canary suite and SNR degradation.
- Validate dual-error test proves learning, not memorization.

### Phase 2: Engram ablations + real data

- Implement Engram-informed ablations (multi-head hash, parameter
  rebalancing, separate gating, causal conv).
- Add real session data export from daemon.
- Run TSTR protocol (train synthetic test real, train real test real,
  train combined test real).
- Produce ablation matrix report.

### Phase 3: Decision gate

- Compare best SSM configuration against production cross-attention
  scorer across full metric suite.
- Document crossover point (session count where SSM beats baseline).
- If gates pass, promote to ssm-temporal-backbone for shadow deployment.
- If gates fail, document which patterns SSM cannot learn and whether
  architectural changes or more data would help.

## 7) Validation and tests

- Canary detection >90% at 20dB, >70% at 10dB on all 7 patterns.
- MSE_True < MSE_Obs on all canary patterns (learning, not memorizing).
- TSTR: synthetic-only training achieves >60% of real-only performance.
- No latency regression: p95 < 5ms on 20-candidate batch.
- Benchmark harness produces identical results across 3 random seeds.
- Cold-start stratification: SSM matches baseline at 1-3 sessions, beats
  by >5% HR@10 at 11-50 sessions.

## 8) Success metrics

- A decision-grade report comparing SSM vs cross-attention on the full
  metric suite, with statistical significance (paired bootstrap, BCa
  confidence intervals, minimum 5 seeds).
- Clear identification of which canary patterns SSM handles better and
  which it doesn't.
- Engram ablation results showing whether parameter rebalancing or
  multi-head hashing improves the existing cross-attention scorer
  independent of the SSM question.

## 9) Open decisions

1. Whether the SSM benchmark should use the Rust autograd tape (matching
   production) or PyTorch (faster iteration). Recommendation: PyTorch
   for evaluation, port winning configuration to Rust afterward.
2. Whether multi-head readout (5 heads) is worth pursuing or if
   single-head relevance is sufficient for the foundation phase.
3. Target parameter budget for SSM candidate: ~1M (parity with current
   scorer) or ~5M (research suggests sweet spot for temporal learning).

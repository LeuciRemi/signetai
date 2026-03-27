---
title: "SSM Temporal Backbone"
id: ssm-temporal-backbone
status: planning
informed_by:
  - "docs/research/technical/RESEARCH-SSM-INTEGRATION.md"
  - "docs/research/technical/SSM-CONTINUAL-LEARNING-DEEP-DIVE.md"
  - "docs/research/technical/SSM-NOVEL-APPLICATIONS.md"
  - "arxiv:2601.07372 (Engram: Conditional Memory via Scalable Lookup)"
section: "Predictive Scorer"
depends_on:
  - "ssm-foundation-evaluation"
  - "ontology-evolution-core"
  - "session-continuity-protocol"
  - "predictive-memory-scorer"
success_criteria:
  - "Temporal SSM sidecar improves long-gap and supersession-sensitive ranking slices"
  - "Learned decay behavior outperforms fixed decay heuristics on benchmark canaries"
  - "Shadow mode serves scores with bounded latency and deterministic fallback"
scope_boundary: "Defines SSM temporal state model integration in shadow mode; does not change graph traversal semantics or enforce production routing"
---

# SSM Temporal Backbone

## 1) Problem

The current scorer treats each session-start scoring as independent.
It receives a query embedding and a bag of candidate features, scores
them, and forgets. There is no model of how relevance evolves over
time. The fixed decay heuristic (`importance * 0.95^ageDays`) is a
single curve applied uniformly to all memories regardless of type,
entity context, or user behavior patterns.

Real relevance follows complex temporal dynamics: weekly work cycles,
project-phase transitions, burst-then-quiet access patterns, and
supersession chains where new facts obsolete old ones at unpredictable
intervals. An SSM can learn these patterns from session history because
its hidden state accumulates temporal context across interactions.

The Engram paper (arxiv:2601.07372) validates a related insight at LLM
scale: static knowledge retrieval should be handled by dedicated
memory pathways (O(1) lookup) while dynamic reasoning (what matters
*now* given *context*) needs a separate mechanism. The temporal
backbone is Signet's version of that separation: the knowledge graph
and embedding search handle static retrieval, the SSM handles temporal
reasoning about what's relevant given the user's evolving patterns.

## 2) Goals

1. Deploy an SSM temporal scorer as a shadow sidecar alongside the
   existing cross-attention scorer, logging predictions without
   affecting production retrieval.
2. Learn per-user temporal patterns (decay curves, cyclic access,
   supersession sensitivity) that the fixed heuristic cannot capture.
3. Support per-user adaptation via LoRA adapters on a shared base
   model, keeping per-user storage under 1.5MB.
4. Integrate ontology signals (confidence, co-occurrence, relationship
   type) as additional SSM input features when available.
5. Provide diagnostics for drift detection, calibration quality, and
   latency monitoring.

## 3) Proposed capability set

### A) Architecture: Mamba-style selective SSM

Based on validation from ssm-foundation-evaluation (Phase 0 gates
must pass first). Architecture follows the PoC with corrections:

```
Session history: [s1, s2, ..., sT]  (ordered by timestamp)
    |
    v
Feature encoder: 17-dim behavioral + ontology signals per candidate
    |
    v
Input projection: Linear(feature_dim, embed_dim)
    |
    v
Selective SSM layers (2x):
  - Depthwise causal Conv1d (kernel=4, SiLU)
  - Input-dependent discretization (A, B, C, delta)
  - Sequential state scan with gating
  - Residual connection + LayerNorm
    |
    v
Relevance head: Linear(embed_dim, 1)
    |
    v
ListNet loss (KL divergence, temperature=0.5)
```

**Parameter budget**: target ~2-5M parameters. The Engram U-shaped
scaling law suggests the current scorer is over-allocated to hash
embeddings (95% of params). The SSM should allocate more evenly
between state matrices and projections.

**Causal convolution**: validated by both the Engram paper (kernel=4,
dilated, SiLU) and the PoC's SelectiveSSM block. Captures local
temporal patterns within a window before the SSM scan handles
long-range dependencies.

### B) Hidden state persistence

The SSM's hidden state represents compressed temporal context.
Persist it across sessions:

- At session end: serialize hidden state to
  `$SIGNET_WORKSPACE/.daemon/ssm/state-{agent_id}.bin`
- At session start: restore hidden state, process new session features,
  produce scores.
- State size: `embed_dim * ssm_state_dim * num_layers` floats.
  At 64 * 32 * 2 = 4,096 f32 values = 16KB per agent.

### C) Per-user LoRA adaptation

Per RESEARCH-SSM-INTEGRATION continual learning architecture:

- Shared base model (~2-5M params, shipped with Signet releases).
- Per-user LoRA adapters on `in_proj`, `out_proj`, `dt_proj` (rank
  8-16, ~150KB-1.5MB per user).
- Session-level TTT: accumulate self-supervised loss during session,
  apply one gradient step at session end to update LoRA adapter.
- Store adapter at `$SIGNET_WORKSPACE/.daemon/ssm/lora-{agent_id}.bin`

### D) Ontology signal integration

When ontology-evolution-core lands, the SSM receives additional input
features per candidate:

- `confidence_mean`: average edge confidence for candidate's entity
- `association_weight`: NPMI-normalized co-occurrence signal
- `relationship_type_id`: categorical encoding of dependency type
- `lineage_depth`: hop count in supersession chain
- `is_latest`: binary flag for current-truth status

These extend the 17-dim feature vector. The SSM learns to weight them
through training, not through hardcoded rules.

### E) Shadow mode integration

Uses the daemon's existing `shadowMode` infrastructure:

- SSM sidecar runs alongside the production scorer.
- Both score the same candidate pool.
- SSM scores are logged to `ssm-temporal-shadow.jsonl` alongside
  production scores.
- Dashboard panel shows SSM vs production agreement rate, per-canary
  performance, and latency distribution.
- No production memory injection changes until Phase 3 (online A/B).

### F) Drift detection and diagnostics

Per RESEARCH-SSM-INTEGRATION drift detection:

- ADWIN-based drift detector on prediction error EMA.
- When drift exceeds threshold: temporarily increase LoRA rank,
  trigger consolidation pass during idle period.
- Diagnostics endpoint: `GET /api/predictor/ssm-status`
  Returns: drift score, last consolidation timestamp, adapter size,
  hidden state age, canary pass rate.

## 4) Non-goals

- No hard cutover from the current cross-attention scorer.
- No graph traversal path mutation (that's ssm-graph-traversal-model).
- No changes to constraint surfacing invariant (constraints always
  surface regardless of SSM score).
- No federated learning or multi-user model sharing in this phase.

## 5) Integration contracts

### SSM Temporal Backbone <-> SSM Foundation

- SSM architecture is the winning configuration from foundation
  evaluation (Phase 0 gates must be green).
- Benchmark harness is reused for ongoing regression testing.
- Canary suite runs as part of shadow diagnostics.

### SSM Temporal Backbone <-> Engram-Informed Predictor Track

- Consumes accepted/rejected Engram-pattern translation decisions from
  `engram-informed-predictor-track`.
- Shadow rollout notes must cite which Engram-inspired deltas were
  carried forward vs rejected.
- No SSM default-path promotion before this handoff is documented.

### SSM Temporal Backbone <-> Ontology Evolution Core

- Consumes confidence, co-occurrence, relationship type, lineage
  signals as additional input features.
- Does not modify ontology state. Read-only consumption.
- Feature pipeline gracefully handles missing ontology signals
  (defaults to zeros, matching pre-ontology behavior).

### SSM Temporal Backbone <-> Session Continuity

- Session checkpoints include SSM hidden state snapshot.
- Recovery injection can use SSM state to prioritize memories that
  the temporal model predicts will be relevant in the resumed session.
- SSM state restoration happens before first scoring call.

### SSM Temporal Backbone <-> Predictive Memory Scorer

- Shadow mode: both scorers run, production scorer's output is used.
- RRF blending parameter alpha can be extended to three-way:
  `alpha_baseline`, `alpha_cross_attention`, `alpha_ssm` (future).
- SSM scores are logged alongside cross-attention scores for offline
  comparison.

## 6) Rollout phases

### Phase 1: Shadow sidecar deployment

- Deploy SSM sidecar process (Python or Rust, based on foundation
  evaluation findings).
- Wire into daemon shadow infrastructure.
- Log predictions, do not affect production scoring.
- Run canary suite as part of shadow diagnostics.
- Monitor latency (must not increase production scoring p95).

### Phase 2: Per-user adaptation

- Enable LoRA adapter storage and session-level TTT.
- Add ontology signals to feature pipeline (behind config flag).
- Add drift detection and consolidation triggers.
- Dashboard panel for SSM diagnostics.

### Phase 3: Blended scoring (online A/B)

- Gradually blend SSM scores into production RRF:
  start at alpha_ssm=0.1, increase based on shadow metrics.
- Track agent feedback signals per arm.
- Minimum 100 sessions before increasing alpha.
- Automatic rollback if regression detected on any metric.

## 7) Validation and tests

- Shadow SSM matches or beats production scorer on all 7 canary
  patterns within first 50 sessions of shadow deployment.
- Learned decay outperforms `0.95^ageDays` on supersession and
  burst canary patterns (measured on held-out test set).
- Per-user LoRA adaptation shows measurable improvement after 10+
  sessions (compared to shared base model without adaptation).
- Latency: SSM scoring adds <2ms p95 to total scoring pipeline.
- Hidden state serialization round-trips without numerical drift.
- Drift detector fires on injected distribution shift within 20
  sessions.

## 8) Success metrics

- Shadow mode quality: SSM's predicted top-K receives statistically
  significantly better agent feedback than production's top-K (p<0.05)
  over minimum 50 sessions (SNIPS counterfactual estimation).
- Cold-start crossover: document the session count where SSM reliably
  beats the baseline. Target: <10 sessions with LoRA adaptation.
- Long-gap improvement: >10% HR@10 improvement on queries spanning
  >7 day session gaps compared to production scorer.
- Supersession sensitivity: SSM correctly demotes superseded memories
  with >80% accuracy on supersession chain canary.

## 9) Open decisions

1. Python or Rust for the SSM sidecar. PyTorch is faster to iterate
   but adds a heavy dependency. A Rust SSM (using the existing autograd
   tape + new SSM ops) keeps the deployment lightweight but requires
   implementing selective scan in Rust.
2. Whether hidden state persistence should be in SQLite (alongside
   existing data) or flat binary files (simpler, faster).
3. The exact LoRA rank and which projections to adapt. Research says
   rank 8-16 on in_proj/out_proj/dt_proj, but the foundation evaluation
   should include a rank sweep.

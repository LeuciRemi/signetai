---
title: "Engram-Informed Predictor Track"
id: engram-informed-predictor-track
status: planning
informed_by:
  - "references/Engram"
  - "arxiv:2601.07372 (Engram: Conditional Memory via Scalable Lookup)"
  - "docs/research/technical/RESEARCH-SSM-INTEGRATION.md"
  - "docs/specs/planning/ssm-foundation-evaluation.md"
section: "Predictive Scorer"
depends_on:
  - "predictive-memory-scorer"
success_criteria:
  - "Engram-inspired scorer ablations are benchmarked with reproducible quality and latency reports against the current cross-attention baseline"
  - "At least one Engram-inspired configuration improves canary quality slices without violating fail-open and latency constraints"
  - "Selected architecture deltas are codified as contracts for ssm-temporal-backbone shadow deployment"
scope_boundary: "Defines how Engram patterns are translated into Signet predictor and SSM planning work; does not embed Engram into the LLM backbone or replace retrieval substrates"
---

# Engram-Informed Predictor Track

Spec metadata:
- ID: `engram-informed-predictor-track`
- Status: `planning`
- Hard depends on: `predictive-memory-scorer`
- Registry: `docs/specs/INDEX.md`

---

## 1) Problem

Signet already carries several Engram-like ideas across the scorer and SSM
planning docs, but they are spread across multiple specs and not tracked as one
execution lane. We need one planning contract that translates Engram patterns
into concrete scorer experiments, selection criteria, and handoff into the SSM
shadow track.

Without this lane, Engram-inspired work risks becoming piecemeal:
- hash path tweaks land without comparable benchmark conditions
- gating and convolution experiments drift from production constraints
- SSM planning references Engram patterns without a locked translation contract

## 2) Goals

1. Establish a single execution lane for Engram-inspired scorer changes.
2. Run reproducible ablations on the current cross-attention scorer before
   changing SSM shadow routing.
3. Define a compatibility contract between selected ablation outcomes and
   `ssm-temporal-backbone`.
4. Preserve current safety properties: fail-open behavior, deterministic
   fallback, bounded latency, and agent scoping.
5. Keep retrieval substrate boundaries explicit: SQLite/FTS/vector/graph remain
   the source of recall truth.

## 3) Proposed capability set

### A) Baseline locking and evaluation parity

Lock a reproducible baseline for current scorer behavior and evaluate all
variants on identical data slices:
- synthetic canary suite from `packages/predictor/bench/`
- real-session exports from predictor training data paths
- identical metric set: HR@K, MRR@K, DCG@K, latency p50/p95/p99

### B) Hash-path translation from Engram

Apply and measure hash-path changes inspired by Engram:
- tokenizer normalization (NFKC + lowercase) before hashing
- prime bucket configuration to reduce systematic collisions
- optional multi-head hash embeddings for text-only candidate encoding
- collision-rate diagnostics alongside retrieval quality metrics

### C) Gate-path translation from Engram

Test scorer variants that separate similarity and gating signals:
- explicit Engram-style alpha gate path
- separate content/value path
- optional depthwise causal Conv1d post-gating (kernel=4, SiLU)
- strict measurement of added latency and stability

### D) Parameter allocation experiments

Test whether current scorer capacity is over-allocated to hash table memory by
running budget reallocation sweeps (for example bucket count vs internal/value
dims) while keeping inference constraints intact.

### E) Handoff contract into SSM track

Codify which Engram-inspired deltas are accepted by `ssm-temporal-backbone`:
- which input encodings remain canonical
- which gating/conv patterns carry forward to SSM architecture tests
- which ideas are explicitly rejected (with reason) to avoid repeated loops

## 4) Non-goals

- No insertion of Engram modules into the underlying LLM backbone.
- No replacement of hybrid retrieval substrate.
- No schema-breaking changes to predictor comparison or training tables.
- No production cutover to SSM from this spec alone.

## 5) Integration contracts

### Engram Track <-> Predictive Memory Scorer

- Keeps current sidecar RPC contract intact.
- Candidate feature vector shape remains backward compatible unless explicitly
  versioned.
- Any scorer variant must preserve fail-open behavior when sidecar is missing.

### Engram Track <-> SSM Foundation Evaluation

- Shares benchmark harnesses and reporting format.
- Engram-inspired ablations become first-class rows in the foundation matrix.
- Foundation decision reports must cite this spec for translation rationale.

### Engram Track <-> SSM Temporal Backbone

- Temporal shadow deployment consumes selected outputs from this track.
- No SSM routing default changes until Engram track recommendations are
  recorded and accepted.
- Deterministic fallback and latency budgets remain unchanged.

### Engram Track <-> Desire Paths

- Path-scoring and traversal invariants stay authoritative.
- Constraint surfacing cannot be suppressed by any Engram-inspired scorer path.

## 6) Rollout phases

### Phase 1: Baseline and instrumentation

- Freeze baseline scorer config and test slices.
- Add collision and latency diagnostics for hash/gate variants.
- Produce a reproducible baseline report.

### Phase 2: Engram-inspired scorer ablations

- Run hash-path and gate-path experiments.
- Run parameter allocation sweeps under fixed latency budgets.
- Publish ablation matrix with reproducible configs.

### Phase 3: SSM handoff contract

- Select accepted deltas.
- Update SSM planning contracts with accepted/rejected findings.
- Document follow-on implementation slices for shadow mode.

## 7) Validation and tests

- Deterministic hashing tests for normalization and bucket variants.
- Feature-dimension and RPC compatibility tests remain green.
- Latency guard tests verify no regression past agreed thresholds.
- Session-end comparison and drift logic still function with variants.

## 8) Success metrics

- One or more Engram-inspired variants improve quality slices on both synthetic
  and real-session evaluation sets.
- p95 scoring latency remains within configured budget envelopes.
- A signed decision report maps selected deltas into SSM temporal planning with
  explicit acceptance and rejection notes.

## 9) Open decisions

1. Should multi-head hashing be retained as a permanent text-path default or
   used only in SSM experiments?
2. Should Engram-style convolution live in the cross-attention scorer or remain
   SSM-only after translation?
3. What is the minimum quality delta required to justify added implementation
   complexity in production scorer code?

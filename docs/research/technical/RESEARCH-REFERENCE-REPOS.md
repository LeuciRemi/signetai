---
title: "Reference Repository Analysis: Ori-Mnemos and Zikkaron"
question: "What retrieval, decay, and learning patterns from competing memory systems are worth adopting into Signet's desire paths epic?"
informed_by:
  - "references/Ori-Mnemos"
  - "references/Zikkaron"
relevance:
  - desire-paths-epic
  - predictive-memory-scorer
---

Reference Repository Analysis: Ori-Mnemos and Zikkaron
=======================================================

*Retrieval, decay, and learning patterns from two open-source memory systems, cataloged for adoption into Signet.*

Reference: `references/Ori-Mnemos/` and `references/Zikkaron/` in the Signet monorepo.

---

## 1. Ori-Mnemos

TypeScript, approximately 12K LOC, 579+ tests.

### Architecture

Six-layer stack, bottom to top:

1. **Markdown on disk** with wiki-link graph structure.
2. **Knowledge graph**: wiki-links, ACT-R decay, spreading activation, zone-based partitioning.
3. **Four-signal fusion**: semantic similarity + BM25 keyword + PersonalizedPageRank + warmth, combined via score-weighted reciprocal rank fusion (RRF).
4. **Dampening pipeline**: gravity, hub, and resolution corrections applied post-fusion.
5. **Retrieval intelligence**: Q-value reranking, co-occurrence learning, stage meta-learning.
6. **MCP server**: 16 tools, 5 resources.

### Key Patterns

#### 1.1 Q-Value Reranking (memRL-inspired)

Notes earn Q-values from session outcomes via exponential moving average (alpha=0.1).

| Reward Signal | Value |
|---------------|-------|
| Forward citation | +1.0 |
| Update after retrieval | +0.5 |
| Downstream creation | +0.6 |
| Within-session re-recall | +0.4 |
| Dead-end (no follow-up) | -0.15 |

Phase B reranking blends z-normalized similarity with Q-value, adding a UCB-Tuned exploration bonus for under-explored notes. Cumulative bias cap at MAX=3.0 with compression=0.3. Exposure-aware correction prevents popular notes from dominating indefinitely.

Key files: `src/core/qvalue.ts` (214 LOC), `src/core/rerank.ts` (146 LOC).

#### 1.2 Co-Occurrence Edges (Hebbian Learning)

Notes retrieved together in the same session grow edges. Normalization uses NPMI (normalized pointwise mutual information). GloVe power-law frequency scaling prevents common terms from inflating co-occurrence scores. Ebbinghaus decay with strength accumulation governs edge lifetime. Per-node Turrigiano homeostasis prevents hub notes from absorbing all edge weight.

The combined wiki-link and co-occurrence graph feeds Personalized PageRank (HippoRAG-style, alpha=0.5).

File: `src/core/cooccurrence.ts` (150 LOC).

#### 1.3 Stage Meta-Learning (LinUCB Contextual Bandits)

Each pipeline stage is wrapped in a LinUCB bandit. An 8-dimensional query feature vector drives three-way decisions: run, skip, or abstain. Cost-sensitive thresholds prevent expensive stages from firing on low-value queries. ACQO two-phase curriculum ramps complexity.

File: `src/core/stage-learner.ts` (150 LOC).

#### 1.4 Intent-Aware Query Routing

Classifies queries into four intents: episodic, procedural, semantic, decision. Classification uses heuristic pattern matching (30+ regex patterns). Each intent type has its own signal weight profile and split weights across title, description, and body fields.

#### 1.5 ACT-R Vitality Model

Seven-factor vitality score:

1. ACT-R base-level activation
2. Metabolic rate (space-dependent)
3. Structural stability boost
4. Access frequency saturation
5. Revival spike
6. Spreading activation boost
7. Bridge protection floor (Tarjan articulation points at >=0.5)

Three memory spaces with distinct decay rates:

| Space | Decay Multiplier |
|-------|-----------------|
| Identity | 0.1x |
| Knowledge | 1.0x |
| Operations | 3.0x |

#### 1.6 Post-Fusion Dampening

Three stages applied after signal fusion:

| Stage | Mechanism |
|-------|-----------|
| Gravity dampening | Halve score for semantic matches with zero query-term overlap |
| Hub dampening | P90 degree penalty on top 10% of notes by edge count |
| Resolution boost | 1.25x multiplier for actionable knowledge types |

#### 1.7 Recursive Memory Harness (RMH)

PPR with exploration-tuned alpha=0.45. Sub-question decomposition with convergence detection. Every retrieval reshapes the graph by updating co-occurrence edges and Q-values.

#### 1.8 Benchmarks

| Benchmark | Metric | Ori-Mnemos | Mem0 | Speedup |
|-----------|--------|------------|------|---------|
| HotpotQA | Recall@5 | 90% | 29% | 3.1x |
| HotpotQA | Latency | 120ms | 1,140ms | 9.5x faster |

LoCoMo results: 44.7% Recall, 20.8% F1, 32.4% MRR, 63.5% AnsF1.

---

## 2. Zikkaron

Python, 26 subsystems, 969 tests.

### Architecture

Five cohesive layers:

1. **Core Storage and Retrieval**: SQLite + vector indexing.
2. **Memory Dynamics**: thermodynamics, reconsolidation, predictive coding.
3. **Consolidation and Organization**: astrocyte pool with domain-specialized workers.
4. **Knowledge Structure**: knowledge graphs, causal discovery, cognitive maps.
5. **Frontier Capabilities**: Hopfield networks, HDC encoding, rules engines, CRDT sync.

### Key Patterns

#### 2.1 Heat-Based Thermodynamic Decay

Every memory carries heat (0.0-1.0), surprise (0.0-1.0, computed as `1 - max_similarity`), and importance (heuristic). DECAY_FACTOR = 0.95.

Three compression levels by age:

| Level | Age Threshold | Fidelity |
|-------|--------------|----------|
| 0 | < 7 days | Full content |
| 1 | 7-30 days | Gist only |
| 2 | > 30 days | Tags only |

Anchor and protection mechanisms prevent critical memories from decaying. Forgetting follows rate-distortion optimal curves per Toth et al. (2020).

#### 2.2 Reconsolidation on Retrieval (Nader et al. 2000)

Retrieved memories are evaluated for context mismatch:

```
mismatch = 0.5 * embedding_distance
         + 0.2 * directory_distance
         + 0.15 * temporal_distance
         + 0.15 * tag_divergence
```

Three outcomes based on mismatch score:

| Mismatch Range | Action |
|----------------|--------|
| < 0.3 | Passive (no change) |
| 0.3 - 0.7 | Reconsolidate (merge with current context) |
| >= 0.7 | Extinction (archive original, create new memory) |

Tracks plasticity (increases on access, 6-hour half-life) and stability (increases with successful retrieval).

#### 2.3 Predictive Coding Write Gate

Only stores information that violates expectations. WRITE_GATE_THRESHOLD = 0.4 (40% minimum surprisal required). Task continuity discount (WRITE_GATE_CONTINUITY_DISCOUNT = 0.15) lowers the threshold when working on the same task. Bypass keywords exist for errors, decisions, and architecture changes. Adaptive gating tracks the last 10 stored memories.

#### 2.4 Hippocampal Replay for Context Compaction

PreCompact hook drains working state into a checkpoint containing: current_task, key_decisions, files_being_edited, active_errors, custom_context, and epoch. PostCompact hook reconstructs from checkpoint + anchored memories + hot memories + recent actions + predictions. Micro-checkpointing fires every N tool calls (default 50).

#### 2.5 Astrocyte Pool (Background Consolidation)

Runs on idle timeout (default 300s). Domain-specialized workers handle code, decision, error, and dependency processing. The pool runs:

- Thermodynamic decay
- Entity extraction
- Knowledge graph building
- Duplicate merging
- Causal discovery (PC algorithm)
- Sleep replay (random memory pair comparison)
- Louvain clustering

#### 2.6 Hopfield Networks (Ramsauer et al. 2021)

```
attention = softmax(beta * X * query)
```

Mathematically equivalent to transformer single-head attention. Fast, no training required. HOPFIELD_BETA = 8.0.

#### 2.7 Typed Knowledge Graph

Bi-temporal model (event_time + record_time). Nine relationship types:

| Type | Semantics |
|------|-----------|
| co_occurrence | Retrieved together |
| imports | Code dependency |
| calls | Function invocation |
| debugged_with | Error resolution pair |
| decided_to_use | Architecture decision |
| caused_by | Causal link |
| resolved_by | Fix reference |
| preceded_by | Temporal ordering |
| derived_from | Lineage |

Confidence scoring on inferred edges. PPR with damping factor 0.85.

#### 2.8 Decision Auto-Protection

Regex detection of decision patterns ("chose over", "decided to use", "switched from", "migrated from", etc.). Matched memories are auto-tagged, set to protected status, given heat=1.0, and assigned a resistance multiplier of 2.0.

#### 2.9 Structured Profile Extraction

Regex patterns extract structured attributes from free-form memory text: interests, traits, travel history, career, goals. Stored as `entity_name/attribute_type/attribute_key/attribute_value/confidence`. Hindsight inference derives attributes from observed behavioral patterns.

#### 2.10 Benchmarks

| Benchmark | Metric | Score |
|-----------|--------|-------|
| LoCoMo | Recall@10 | 86.8% |
| LoCoMo | MRR | 0.708 |
| LongMemEval | Recall@10 | 96.7% |
| LongMemEval | MRR | 0.945 |
| LongMemEval (knowledge updates) | MRR | 1.000 |

---

## 3. Cross-Reference Table

| Pattern | Ori-Mnemos | Zikkaron | Signet Equivalent | Gap |
|---------|-----------|----------|-------------------|-----|
| Multi-signal fusion | 4-signal RRF | 8-signal WRRF | traversal + FTS5 + cosine | Missing: warmth, PageRank as explicit signals |
| Q-value / path feedback | Q-value per note | Heat per memory | DP-9 (specced, not started) | Need to absorb Q-value reward vocabulary |
| Co-occurrence growth | Hebbian edges | co_occurrence type | entity_dependencies (static) | No dynamic edge creation from retrieval |
| Intent routing | 4 intents, per-intent weights | Query type detection | None | Full gap |
| Write gate | N/A | Surprisal threshold | DP-1 significance gate | DP-1 is session-level, Zikkaron is per-memory |
| Memory decay | ACT-R 7-factor | Thermodynamic heat | Structural density | Different philosophy, both valid |
| Reconsolidation | N/A | Mismatch-based update | None | Full gap |
| Context compaction | N/A | Hippocampal replay | Session continuity (partial) | Missing compaction hooks |
| Background consolidation | N/A | Astrocyte pool | Sync pipeline | No background workers |
| Hopfield retrieval | N/A | Single-head attention equiv | None | Fast reranking alternative |
| Stage learning | LinUCB bandits | N/A | None | Post-DP optimization |
| Recursive exploration | RMH framework | N/A | DP-12 explorer bees | Similar concept, different mechanism |
| Post-fusion dampening | Gravity + hub + resolution | N/A | Cosine re-scoring only | Missing hub and gravity |
| Typed relationships | Wiki-links | 9 relationship types | entity_dependencies (untyped) | No relationship taxonomy |
| Decision protection | N/A | Regex auto-protect | None | Quick win |
| Profile extraction | N/A | Regex attribute mining | Inline entity linker (DP-6a) | Similar, Zikkaron more structured |

Note: For Supermemory ASMR pattern comparisons (structured extraction categories, temporal timeline reconstruction, multi-lens search, ensemble answering, fact supersession tracking), see section 6.

---

## 4. Adoption Priority

| Priority | Pattern | Source | Signet Target | Rationale |
|----------|---------|--------|---------------|-----------|
| Immediate | Q-value reward signals | Ori-Mnemos | DP-9 (path feedback) | Directly maps to desire path reinforcement. Reward vocabulary is well-defined and testable. |
| Immediate | Decision auto-protection | Zikkaron | New story (DP-16) | Regex-based, low implementation cost, high value for architecture decision retention. |
| Immediate | Post-fusion dampening | Ori-Mnemos | DP-6 traversal refinement | Hub penalty and gravity dampening address known over-retrieval of high-degree entities. |
| Next wave | Predictive coding write gate | Zikkaron | DP-1 amendment | Per-memory surprisal gating is more granular than session-level significance. Port the threshold model. |
| Next wave | Co-occurrence edge growth | Ori-Mnemos | DP-10 or new story (DP-17) | Hebbian edges from retrieval co-occurrence would make entity_dependencies dynamic. Requires decay model. |
| Next wave | Typed relationships | Zikkaron | DP-18 (new story) | Nine relationship types with confidence scoring. Replaces untyped entity_dependencies. |
| Next wave | Reconsolidation on retrieval | Zikkaron | DP-19 (new story) | Mismatch-based update/extinction prevents stale memories from persisting. Needs careful testing. |
| Next wave | Intent routing | Ori-Mnemos | DP-6 or DP-20 (new story) | Per-intent signal weights improve retrieval precision. Pattern-matching classifier is lightweight. |
| Experimental | Stage meta-learning (LinUCB) | Ori-Mnemos | Post-DP optimization | Requires stable pipeline stages before wrapping in bandits. High reward, high complexity. |
| Experimental | Hopfield retrieval | Zikkaron | Reranker alternative | Fast, no training. Worth benchmarking against current cosine re-scoring. |
| Experimental | Astrocyte pool | Zikkaron | Background consolidation | Domain-specialized workers for idle-time processing. Significant architecture addition. |
| Experimental | Hippocampal replay | Zikkaron | Session continuity extension | Micro-checkpointing and compaction hooks. Requires connector-level integration. |
| Experimental | ACT-R vitality model | Ori-Mnemos | Decay model alternative | Seven-factor model is more sophisticated than structural density. Evaluate against current approach. |

---

## 5. Benchmark Comparison

| Metric | Signet (DP-6) | Ori-Mnemos | Zikkaron | Notes |
|--------|---------------|------------|----------|-------|
| LoCoMo Accuracy | 87.5% | N/A | N/A | 8-question sample, full stack (DP-16 + lossless transcripts) |
| LoCoMo Hit@10 | 100% | N/A | 86.8% | Signet at k=10, full retrieval coverage |
| LoCoMo Recall@5 | N/A | 44.7% | N/A | Ori-Mnemos reports Recall (unspecified k) |
| LoCoMo Recall@10 | 100% | N/A | 86.8% | Perfect recall, zero retrieval misses |
| LoCoMo MRR | 0.615 | 32.4% | 70.8% | Signet approaching Zikkaron |
| LoCoMo F1 | N/A | 20.8% | N/A | Only Ori-Mnemos reports F1 |
| LoCoMo AnsF1 | N/A | 63.5% | N/A | Answer-level F1 |
| HotpotQA Recall@5 | N/A | 90% | N/A | Ori-Mnemos only |
| LongMemEval Recall@10 | N/A | N/A | 96.7% | Zikkaron only |
| LongMemEval MRR | N/A | N/A | 94.5% | Zikkaron only |

Signet numbers are from an 8-question sample (run-full-stack-8, 2026-03-22) and have not yet been validated on the full LoCoMo dataset. Metrics are not directly comparable across systems due to differences in k-values, dataset splits, and evaluation methodology. Initial results show perfect recall at k=10 and strong accuracy, with MRR trailing Zikkaron — likely improvable with reranking refinements on the full dataset.

---

## 6. Supermemory ASMR (Agentic Search and Memory Retrieval)

Published circa March 2026. Claims ~99% on LongMemEval-s.

### Architecture

Multi-agent orchestration pipeline replacing vector search entirely:

1. **Ingestion**: 3 parallel reader agents (Gemini 2.0 Flash) extract structured knowledge across 6 categories: personal information, preferences, events, temporal data, updates, assistant info.
2. **Retrieval**: 3 parallel search agents with specialized foci: direct facts, contextual implications, temporal timeline reconstruction.
3. **Answering**: 8-12 specialized prompt variants running in parallel, with aggregator LLM for consensus.

### Results

| Run | Method | LongMemEval-s Accuracy |
|-----|--------|----------------------|
| Run 1 | 8-variant ensemble (any-correct) | 98.60% |
| Run 2 | 12-variant decision forest + aggregator | 97.20% |

### Critical Assessment

**Methodology concern**: Run 1's 98.60% marks a question correct if ANY of 8 independent prompt variants gets the right answer. This is coverage, not single-system accuracy. Run 2 (97.20%) with majority-vote aggregation is the more honest metric.

**Cost**: 15-19 LLM calls per query (3 search + 8-12 answer + 1 aggregator). Not viable for production use at scale without significant cost reduction.

**No embeddings**: Uses LLMs as the search engine rather than vector similarity. Eliminates the "semantic similarity trap" for temporal data but trades compute cost for retrieval quality.

### Patterns Worth Adopting

| Pattern | Supermemory Approach | Signet Equivalent | Gap |
|---------|---------------------|-------------------|-----|
| Structured extraction categories | 6 typed categories (personal, preferences, events, temporal, updates, assistant) | entity/aspect/attribute hierarchy + typed extraction | Partial overlap. Signet lacks explicit "Updates" category for tracking supersession at extraction time |
| Temporal timeline reconstruction | Dedicated search agent reconstructs event timelines | Supersession detection (4-signal heuristic) + temporal extraction | Signet detects contradictions but doesn't reconstruct timelines at query time |
| Multi-lens search | 3 agents with different search foci | Traversal + FTS5 + vector (3 retrieval channels) | Architecturally similar. Signet's channels are algorithmic, not agentic |
| Ensemble answering | 8-12 specialized prompts + aggregator | N/A (Signet is retrieval, not answering) | Not applicable — Signet provides context, not answers |
| Fact supersession tracking | Explicit "Updates" extraction category | Retroactive supersession (implemented 2026-03-19) | Signet has write-time detection; Supermemory has extraction-time categorization |

### Adoption Priority

| Priority | Pattern | Rationale |
|----------|---------|-----------|
| Low cost / high value | Temporal-aware retrieval fallback | For queries with temporal markers, one focused LLM call reading raw transcripts to reconstruct timeline. Bridges gap between supersession detection and full timeline reasoning. |
| Medium cost / medium value | "Updates" extraction category | Add explicit change-tracking to extraction prompt so the LLM flags when a new fact supersedes an old one at extraction time, complementing the existing write-time heuristic. |
| High cost / uncertain value | Multi-agent search | Replacing algorithmic retrieval with LLM agents. Our 3-channel retrieval achieves similar coverage at fraction of cost. Only worth revisiting if benchmark results plateau. |

---

This document informs amendments to the desire paths epic (DP-9 through DP-15) and new stories DP-16 through DP-20.

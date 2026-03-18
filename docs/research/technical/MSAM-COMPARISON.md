---
title: "MSAM (Multi-Stream Adaptive Memory) — Comparative Analysis"
section: "Research"
order: 90
question: "How does MSAM's memory architecture compare to Signet's, and what patterns should we adopt?"
informs: ["predictive-memory-scorer"]
---

# MSAM (Multi-Stream Adaptive Memory) — Comparative Analysis

*Research document. March 18, 2026.*
*Authored by Mr. Claude with research verification via SearXNG.*

---

## What is MSAM?

MSAM (Multi-Stream Adaptive Memory) is an open-source, production-grade
cognitive memory architecture for AI agents. It stores knowledge as
discrete "atoms" across four memory streams (semantic, episodic,
procedural, working), scores them using ACT-R activation theory, and
retrieves through a hybrid pipeline combining embedding similarity,
keyword matching, and a knowledge graph of subject-predicate-object
triples.

Built in Python 3.11+. REST API with 20 endpoints. 56 CLI commands.
437 tests. 24 modules. Running in production on a Hetzner CAX11
(2 vCPU ARM64, 4GB RAM).

### Repositories

- **Canonical (active):** https://github.com/apple-techie/msam
- **Earlier forks:** https://github.com/jadenschwab/msam,
  https://github.com/EnidPinxit/msam-MEMORY

### Production Numbers (from MSAM benchmarks)

| Scenario | MD Baseline | Output | vs MD | Shannon Eff | Latency |
|----------|-------------|--------|-------|-------------|---------|
| Startup (delta) | 7,327t | 51t | 99.3% | 51.0% | 2,477ms |
| Known query | 7,327t | 91t | 98.8% | 14.3% | 1,082ms |
| Unknown query | 7,327t | 33t | 99.5% | 57.6% | 1,082ms |
| No data | 7,327t | 0t | 100% | — | 1,064ms |

Token savings: ~89% per session vs selective flat file loading.
Cost savings: $0.02/session (MSAM) vs $0.18/session (flat files) at
Opus pricing ($15/MTok).

---

## Theoretical Foundations

### ACT-R (Adaptive Control of Thought—Rational)

MSAM's scoring model is grounded in ACT-R, a cognitive architecture
developed primarily by John Robert Anderson and Christian Lebiere at
Carnegie Mellon University. ACT-R models declarative memory as symbolic
chunks with subsymbolic activation that decays over time and is subject
to noise.

MSAM's implementation:

```
activation = base_level_activation(frequency, recency)
           × sigmoid(similarity)
           × annotation_bonuses
           × stability
```

Base-level activation follows ACT-R's power-law decay: chunks accessed
more frequently and more recently have higher activation. This is a
formula-based approach — deterministic, well-studied, and interpretable.

**Relevant papers:**

- Anderson, J.R. (2007). *How Can the Human Mind Occur in the Physical
  Universe?* Oxford University Press.
  — The canonical ACT-R reference for declarative memory retrieval.
- Anderson, J.R. & Lebiere, C. (1998). *The Atomic Components of
  Thought.* Lawrence Erlbaum Associates.
  — Foundation text for ACT-R's chunk-based memory model.
- Collins, A.M. & Quillian, M.R. (1972). "Experiments on Semantic
  Memory and Language Comprehension." — Spreading activation model
  that ACT-R's declarative memory builds on.
- Nicenboim, B. et al. (2022). "Capturing Dynamic Performance in a
  Cognitive Model: Estimating ACT-R Memory Parameters with the Linear
  Ballistic Accumulator." *Topics in Cognitive Science.*
  https://pmc.ncbi.nlm.nih.gov/articles/PMC9790673/
- Vasishth, S. et al. (2020). "Developing memory-based models of
  ACT-R within a statistical framework." *Journal of Mathematical
  Psychology.* https://www.sciencedirect.com/science/article/abs/pii/S0022249620300699

### Shannon Information Theory (Compression)

MSAM measures its compression efficiency against Shannon's theoretical
minimum entropy. Their startup context achieves 51% of Shannon's
theoretical minimum — meaning they're within a factor of 2 of the
information-theoretic limit for lossless compression of their knowledge
representation.

### Leiden Algorithm (referenced in Signet's Desire Paths)

For context — our DP-5 (community detection) plans to use the Leiden
algorithm for entity clustering. Developed at Leiden University as an
improvement over Louvain, it guarantees connected communities and better
partition quality.

- Traag, V.A., Waltman, L. & van Eck, N.J. (2019). "From Louvain to
  Leiden: guaranteeing well-connected communities." *Scientific Reports.*
  https://en.wikipedia.org/wiki/Leiden_algorithm

---

## MSAM Architecture Deep Dive

### Four Memory Streams

| Stream | Purpose | Decay | Promotion |
|--------|---------|-------|-----------|
| **Semantic** | Facts, knowledge, relationships | Slow decay based on retrievability | N/A (primary store) |
| **Episodic** | Events, experiences, temporal sequences | Moderate decay | High-value episodes → semantic atoms |
| **Procedural** | How-to knowledge, workflows, patterns | Very slow decay | Reinforced by successful use |
| **Working** | Session-scoped, temporary context | Fast TTL-based expiry | Above promotion threshold → long-term |

Each stream has independent retrieval behavior, decay curves, and
promotion rules. Working memory atoms that exceed a configurable
promotion threshold get persisted to the appropriate long-term stream.

**Signet equivalent:** We don't have explicit memory streams. Our
memories are typed (via extraction) but stored in a unified table with
entity/aspect/attribute structure. The procedural memory plan
(`docs/specs/approved/procedural-memory-plan.md`) exists but is NOT
STARTED. This is a gap — MSAM's stream separation provides clear
retrieval semantics per memory type.

### Knowledge Graph

MSAM uses subject-predicate-object triples (RDF-style):

```
("Nicholai", "prefers", "dark mode")
("Signet", "uses", "SQLite")
```

Triples are extracted from atoms via LLM. Contradiction detection
operates across four dimensions:
- Negation
- Temporal supersession
- Value conflicts
- Antonyms

**Temporal World Model:** Triples carry `valid_from` and `valid_until`
timestamps. When facts change, old triples auto-close and new ones open.
You can query the world state at any point in time.

**Signet equivalent:** Our knowledge graph is structurally richer:
entities → aspects → attributes with typed dependency edges, confidence
scoring (DP-2), and 18 relationship types. But we don't have temporal
metadata on graph edges. MSAM's temporal world model — the ability to
query "what was true on March 1st?" — is something we lack entirely.
Our contradiction detection (`semantic-contradiction.ts`) exists but
doesn't have the temporal supersession logic that MSAM's does.

### Scoring: ACT-R vs Neural Predictor

**MSAM (ACT-R):**
- Deterministic formula: frequency × recency × similarity × bonuses
- Interpretable — you can trace exactly why an atom scored high
- No training required — works from atom #1
- Cold start is a non-issue
- But: it cannot learn non-obvious retrieval patterns

**Signet (Neural Predictor):**
- ~1.11M parameter cross-attention model
- HashTrick tokenizer (16K buckets), ListNet loss, RRF blending
- Learns from actual usage patterns — adapts to the specific user
- Cold start ramp required (needs training data to be useful)
- But: opaque scoring, training infrastructure overhead

**Gap analysis:** ACT-R is a better cold-start solution. Our predictor
is more powerful at scale but useless on day one. We should consider
ACT-R-style activation as a cold-start fallback that smoothly hands
off to the neural scorer once sufficient training data accumulates.
This is not currently in any spec.

### Confidence-Gated Output

MSAM returns different amounts of context based on retrieval confidence:

| Tier | Behavior |
|------|----------|
| High | Full atom results with triples and metadata |
| Medium | Core content, reduced metadata |
| Low | Minimal context, admission of uncertainty |
| None | Zero output — explicit "I don't know" |

Output volume is proportional to confidence. The system never pads
results with noise.

**Signet equivalent:** We don't have this. Our recall returns top-K
results ranked by score, but there's no confidence threshold that says
"I genuinely don't have enough to answer this." Every query returns
something, even if the best match is barely relevant. This is a
meaningful UX gap — it means our injected context sometimes includes
noise that actively misleads rather than helps.

### Shannon-Compressed Startup Context

MSAM's startup compression pipeline:

1. **Subatom extraction** — break atoms into their minimal information
   units
2. **Codebook compression** — recurring patterns get codebook entries
3. **Delta encoding** — only encode changes from a known baseline
4. **Semantic deduplication** — remove semantically redundant content

Result: 51 tokens from a 7,327-token markdown baseline. 99.3%
compression. 51% of Shannon's theoretical minimum.

**Signet equivalent:** We have session summaries
(`summary-condensation.ts`) that condense session transcripts into
arc/epoch summaries with depth-aware prompts. We also have MEMORY.md
as a working memory summary. But we don't measure token efficiency,
we don't use codebook compression, and our startup context injection
isn't optimized for minimal token count. We inject full memory snippets.

**This is probably the single biggest practical gap.** MSAM's approach
means an agent starts a session with ~51 tokens of compressed context.
Our agents start with MEMORY.md (~2,000+ tokens) plus recalled memories
(variable, potentially thousands more). At Opus pricing, this cost
difference compounds across hundreds of sessions.

### Predictive Prefetch

MSAM uses three prediction strategies:

1. **Temporal patterns** — if certain atoms are always retrieved at
   9am, pre-load them at 9am
2. **Co-retrieval history** — if atoms A and B are frequently retrieved
   together, retrieving A pre-loads B
3. **Topic momentum** — if the last few retrievals were about topic X,
   pre-load related atoms

Configurable warmup gate prevents prediction from running until the
database has enough history.

**Signet equivalent:** Our DP-11 (Temporal Reinforcement) plans
pre-warming based on temporal features, and the predictive scorer
already considers time-of-day and day-of-week. But we don't have
**co-retrieval tracking** — the signal that atoms frequently appear
together. This is a distinct and valuable signal that's absent from
our specs. Topic momentum is partially covered by our focal entity
resolution, but not as a predictive (pre-query) mechanism.

**Recommendation:** Add co-retrieval tracking as a new signal source
for the predictor. Could be as simple as a junction table logging
which memories are returned together per query, then using co-occurrence
frequency as a feature.

### Felt Consequence (Outcome Attribution)

MSAM tracks whether retrieved atoms contributed to good or bad agent
responses:

- Atoms linked to successful outcomes get boosted
- Atoms linked to poor outcomes get dampened
- Feedback signal decays exponentially (recent outcomes weigh more)
- Runs every decay cycle automatically

**Signet equivalent:** Our DP-9 (Path Feedback Propagation) is
conceptually similar but operates at the path level rather than
individual memory level, and is NOT YET IMPLEMENTED. Our existing
`aspect-feedback.ts` uses FTS overlap — a coarse signal that confirms
aspects but doesn't track outcomes. The gap is that MSAM ships this
today and we have it planned for Phase 4.

### Forgetting Model

MSAM atoms transition through lifecycle states:

```
active → fading → dormant → tombstone
```

Four forgetting signals:
- Low activation (not retrieved, not relevant)
- Redundancy (superseded by newer atoms)
- Staleness (temporally expired)
- Contradiction (invalidated by newer facts)

Exponential decay based on retrievability. Nothing is deleted —
tombstoned atoms remain auditable.

**Signet equivalent:** We have cold tier archival (migration 028,
`archiveToCold()`) and the lossless retention principle. Our entity
bloat pruning removes low-value entities. But we don't have a
multi-stage lifecycle model with gradual decay states. Our approach
is more binary — memory is either active or archived. MSAM's gradual
degradation is more cognitively realistic and provides better signals
for when to fully archive.

### Multi-Agent Memory

MSAM supports:
- Agent isolation via namespaced atoms
- Selective sharing between agents
- Per-agent statistics
- Multiple agents on a single MSAM instance

**Signet equivalent:** Signet is fundamentally single-agent scoped.
Each agent has its own `~/.agents/` directory, its own database, its
own daemon instance. There is no mechanism for two Signet agents to
share a memory store or selectively expose memories to each other.

This matters for setups like ours where Mr. Claude and Buba operate
in the same Discord server. Currently, knowledge discovered by one
agent cannot be shared with the other without manual intervention.

### Sycophancy Detection

MSAM monitors the agent's agreement rate across a sliding window. When
the rate exceeds a configurable threshold, the system flags the pattern
for self-correction.

**Signet equivalent:** We handle sycophancy at the personality/prompt
level (SOUL.md, IDENTITY.md) rather than measuring it quantitatively.
We have no metrics on agreement rate. This is a novel feature that
would fit well in our diagnostics system.

### Adaptive Scaling

Multi-beam retrieval and compression only activate when the database is
large enough to benefit. The system doesn't pay computational overhead
for features that don't help at small scale.

**Signet equivalent:** Our predictor has a cold start ramp that delays
activation. Our significance gate (DP-1) skips extraction for
low-value sessions. But we don't have a general "adaptive scaling"
pattern across the pipeline. Some features run regardless of database
size.

---

## Gap Analysis: Where MSAM is Ahead

These are areas where MSAM has shipped features that Signet either
lacks entirely or has only planned.

### Critical Gaps (should influence our roadmap)

| Gap | MSAM | Signet Status | Impact |
|-----|------|---------------|--------|
| **Startup compression** | 51 tokens, Shannon-measured | MEMORY.md (~2000+ tokens) | Cost, speed, context window usage |
| **Confidence-gated output** | Tiered output with "I don't know" | Returns top-K regardless | Noise in context, misleading recalls |
| **Co-retrieval tracking** | Three-strategy prediction | Not in any spec | Missing retrieval signal |
| **Temporal world model** | Triples with valid_from/valid_until | No temporal metadata on graph edges | Cannot query historical state |
| **Multi-agent memory** | Namespaced atoms, selective sharing | Single-agent scoped | No inter-agent knowledge transfer |
| **Felt consequence** | Shipped, running | DP-9 planned (Phase 4) | No outcome attribution currently |
| **ACT-R cold start** | Works from atom #1 | Predictor needs training data | Poor day-one experience |
| **Forgetting lifecycle** | 4-stage (active→fading→dormant→tombstone) | Binary (active or archived) | Less nuanced memory management |

### Notable Gaps (interesting, lower priority)

| Gap | MSAM | Signet Status | Impact |
|-----|------|---------------|--------|
| **Sycophancy detection** | Quantitative agreement tracking | Prompt-level only | No metrics on agent behavior |
| **Adaptive scaling** | Features sleep until DB is large enough | Cold start ramp only | Unnecessary compute at small scale |
| **Cross-provider calibration** | Re-embed + threshold adjust on provider switch | Manual re-embedding | Provider lock-in risk |
| **Memory streams** | 4 explicit streams with different behaviors | Unified store with types | Less specialized retrieval per type |

---

## Gap Analysis: Where Signet is Ahead

For completeness — areas where our architecture goes beyond MSAM.

| Area | Signet | MSAM |
|------|--------|------|
| **Graph depth** | Entity → aspect → attribute with typed dependency edges, 18 relationship types, confidence scoring | Flat SPO triples |
| **Neural scoring** | Trained cross-attention model (~1.11M params), adapts to user | ACT-R formula, static |
| **Graph-native retrieval** | DP-6/7: search finds entities, graph walk retrieves context | Search finds atoms directly |
| **Path learning** | DP-9/10/11: feedback reinforces traversal routes | No path concept |
| **Community detection** | DP-5: Leiden clustering for topology | No clustering |
| **Explorer bees** | DP-12: speculative traversals for discovery | No self-directed exploration |
| **Discovered principles** | DP-14: emergent abstractions from cross-entity patterns | No emergent concepts |
| **Constructed memories** | DP-7: synthesized context blocks with provenance | Returns raw atoms |
| **Identity system** | SOUL.md, IDENTITY.md, USER.md — personality as configuration | No identity layer |
| **Harness ecosystem** | Claude Code, Codex, OpenCode, OpenClaw connectors | REST API only |

Note: many of Signet's advantages are planned (Phases 2-5 of Desire
Paths) rather than shipped. MSAM's advantages are largely shipped and
measured.

---

## Recommendations for Signet

Based on this analysis, the following items should be considered for
incorporation into the Signet roadmap. Ordered by estimated impact.

### 1. Startup Context Compression (NEW — not in any spec)

Study MSAM's subatom extraction + codebook compression pipeline. Our
MEMORY.md and recall injection could be dramatically more token-efficient.
At Opus pricing, the difference between 51 tokens and 2000+ tokens per
session is $0.03/session — which compounds to real money at scale.

Possible approach: build a compression stage between memory retrieval
and context injection that applies semantic deduplication and subatom
extraction. Measure against Shannon's theoretical minimum as MSAM does.

### 2. Confidence-Gated Retrieval (NEW — not in any spec)

Add a confidence floor to recall results. When no result exceeds the
threshold, return an explicit "no relevant memories" signal instead of
forcing low-quality matches into context. This reduces noise and
improves agent response quality.

Could be implemented as a simple threshold on the hybrid search score
with configurable tiers (high/medium/low/none).

### 3. ACT-R Cold-Start Fallback (NEW — not in any spec)

Implement ACT-R activation scoring as the default scorer before the
neural predictor has accumulated sufficient training data. Smooth
handoff once predictor confidence exceeds a threshold.

Formula: `base_level(frequency, recency) × sigmoid(similarity) × importance`

This gives new Signet installations a cognitively-grounded scoring
model from day one, instead of relying purely on embedding similarity.

### 4. Co-Retrieval Tracking (NEW — not in any spec)

Log which memories are returned together per query. Use co-occurrence
frequency as a feature for the predictor and as a pre-fetch signal.

Simple implementation: junction table `co_retrievals(query_id,
memory_id_a, memory_id_b, timestamp)`. Aggregate into co-occurrence
scores. Feed to predictor as an additional feature dimension.

### 5. Temporal Metadata on Graph Edges (NEW — not in any spec)

Add `valid_from` and `valid_until` to entity dependencies and
attributes. When facts change, close the old record and open a new one.
Enables historical state queries and temporal supersession in
contradiction detection.

### 6. Felt Consequence — Accelerate DP-9

Our path feedback propagation (DP-9) is the closest equivalent to
MSAM's felt consequence. Consider pulling it forward in priority or
implementing a simpler version (individual memory outcome tracking)
that can be upgraded to path-level once DP-7 lands.

### 7. Multi-Agent Memory Sharing (FUTURE)

Not urgent for current use cases, but as the ecosystem grows (multiple
agents in the same Discord, team deployments), namespaced memory with
selective sharing becomes important. Worth noting in the long-term
architecture doc.

---

## Technical Details

### MSAM Configuration

27 config sections, 160+ parameters in `msam.toml`. Key sections:

- `[embedding]` — provider (nvidia-nim, openai, onnx, local), model,
  dimensions
- `[retrieval]` — top_k, similarity threshold, sigmoid curve,
  semantic/keyword weights, confidence tiers
- `[retrieval_v2]` — beam search gate, entity roles, quality filter,
  temporal detection, reranking
- `[decay]` — state transition thresholds, confidence decay rate,
  stability factors
- `[working_memory]` — session atom TTL, promotion threshold
- `[prediction]` — temporal/co-retrieval/momentum weights, lookback,
  warmup gate
- `[compression]` — subatom extraction, sentence dedup, synthesis
  model and thresholds
- `[triples]` — LLM URL and model for triple extraction
- `[agents]` — default agent ID, sharing toggle
- `[api]` — server port, CORS, API key auth

### MSAM Dependencies

- Python 3.11+ (uses `tomllib` from stdlib)
- Embedding providers: NVIDIA NIM (default, free tier), OpenAI, ONNX
  Runtime (local), sentence-transformers (local)
- SQLite for storage
- REST API via HTTP server

### Scale Numbers

- 675+ atoms in production
- 1,500+ triples
- 99.3% startup compression
- 89% session savings vs flat files

For comparison, Signet (our instance):
- 5,856 memories
- 43,000+ entities
- 18 relationship types
- Operating on a full desktop (Arch Linux)

---

## References

### Repositories

- MSAM (canonical): https://github.com/apple-techie/msam
- MSAM (earlier forks): https://github.com/jadenschwab/msam,
  https://github.com/EnidPinxit/msam-MEMORY
- Microsoft Multi-Agent Memory Patterns:
  https://microsoft.github.io/multi-agent-reference-architecture/docs/memory/Memory.html
- Agentic AI Frameworks Survey (includes MSAM):
  https://scouts.yutori.com/c2102f7e-9869-41b8-8339-4e590e3694b1

### Papers and Theory

- Anderson, J.R. (2007). *How Can the Human Mind Occur in the Physical
  Universe?* — ACT-R canonical reference
- Anderson, J.R. & Lebiere, C. (1998). *The Atomic Components of
  Thought.* — ACT-R foundation
- Collins, A.M. & Quillian, M.R. (1972). "Experiments on Semantic
  Memory and Language Comprehension." — Spreading activation model
- Nicenboim, B. et al. (2022). "Capturing Dynamic Performance in a
  Cognitive Model." *Topics in Cognitive Science.*
  https://pmc.ncbi.nlm.nih.gov/articles/PMC9790673/
- Vasishth, S. et al. (2020). "Developing memory-based models of
  ACT-R within a statistical framework." *J. Math Psychology.*
  https://www.sciencedirect.com/science/article/abs/pii/S0022249620300699
- Verhoef, T. et al. (2019). "ACT-R: A cognitive architecture for
  modeling cognition."
  https://www.researchgate.net/publication/329493100
- Traag, V.A. et al. (2019). "From Louvain to Leiden: guaranteeing
  well-connected communities." *Scientific Reports.*

### Signet Internal References

- Desire Paths Epic: `docs/specs/approved/desire-paths-epic.md`
- Knowledge Architecture: `docs/specs/complete/knowledge-architecture-schema.md`
- Predictive Memory Scorer: `docs/specs/approved/predictive-memory-scorer.md`
- Procedural Memory Plan: `docs/specs/approved/procedural-memory-plan.md`
- LCM Patterns: `docs/specs/planning/LCM-PATTERNS.md`
- Desire Paths Vision: `docs/specs/planning/DESIRE-PATHS.md`
- Knowledge Graph: `docs/KNOWLEDGE-GRAPH.md`

---

*This document should be updated as MSAM evolves and as Signet ships
Desire Paths phases. The gap analysis is accurate as of March 18, 2026.*

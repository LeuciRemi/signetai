---
title: AI Agent Memory Systems — Benchmark Comparison
date: 2026-03-21
source: SearXNG research, arXiv papers, vendor docs, DEV Community, HN
section: "Research"
order: 91
question: "How does Signet's retrieval accuracy compare to competitors on standard benchmarks?"
informs: [desire-paths-epic, predictive-memory-scorer]
---

# AI Agent Memory Systems — Benchmark Comparison (March 2026)

## Benchmark Landscape

**LoCoMo** (Long Conversation Memory) from Snap Research is the de facto
standard. 10 conversations (~418 turns each), 1,540 QA pairs across four
categories: single-hop retrieval, multi-hop inference, temporal reasoning,
and open-domain QA. Published at ACL 2024 (arXiv:2402.17753).

**LongMemEval** — enterprise-focused multi-session evaluation. More
meaningful than DMR for production systems. Tests preference recall,
temporal reasoning, multi-session coherence.

**DMR** (Deep Memory Retrieval) — MemGPT/MSC dataset, 500 conversations.
Considered too easy: full-context GPT-4-Turbo scores 98.2%. Mostly
historical significance.

**LoCoMo-Plus** (Feb 2026) — Level-2 cognitive memory benchmark testing
implicit constraint recall under intentional cue-trigger semantic
disconnect. All existing systems show substantial drops from LoCoMo to
LoCoMo-Plus. Best baseline: Gemini 2.5 Pro at 45.7%.

### Critical Caveat

No standardized LoCoMo leaderboard exists. The Kumiho paper (arXiv:
2603.17244) explicitly states: "all reported numbers use varying
evaluation configurations (different judge models, question subsets,
and evaluation prompts)." Mem0 uses J-score (0-100 LLM judge), most
others use binary accuracy percentage. These are not directly
comparable. Independent reproductions of Mem0's numbers put them closer
to ~58%, significantly below the self-reported 66.9%.

---

## LoCoMo Leaderboard

Compiled from published papers, vendor docs, and independent evaluations.

| Rank | System | Score | Metric | LLM Required | Open Source | Source |
|------|--------|-------|--------|--------------|-------------|--------|
| 1 | Kumiho | 0.565 F1 / 97.5% adv | F1 (official) | GPT-4o | SDK open | arXiv:2603.17244 |
| 2 | EverMemOS | 93.05% | Judge (self-reported) | Cloud | No | evermind.ai blog |
| 3 | MemU | 92.09% | Judge | Cloud | Yes | memu.pro/benchmark |
| 4 | MemMachine v0.2 | 91.7% | Judge | GPT-4.1-mini | No | memmachine.ai blog |
| 5 | Hindsight | 89.6% | Judge | Cloud | Yes (MIT) | arXiv:2512.12818 |
| 6 | SLM V3 Mode C | 87.7% | Judge | Yes (synthesis) | Yes (MIT) | arXiv:2603.14588 |
| 7 | **Signet (full stack)** | **87.5%** | **Judge** | **Local + GPT-4o judge** | **Yes** | **Internal (8-Q sample)** |
| 8 | Zep/Graphiti | ~85% | Judge (third-party) | Cloud | Partial | DEV Community |
| 9 | Letta/MemGPT | ~83% | Judge | Cloud | Yes (Apache) | letta.com blog |
| 10 | Engram | 80.0% | Judge | Gemini 2.0 Flash | Yes | engram.fyi/research |
| 11 | SLM V3 Mode A | 74.8% | Judge | **None** | Yes (MIT) | arXiv:2603.14588 |
| 12 | Mem0+Graph | 68.4% | J-score (disputed) | GPT-4o | Partial | arXiv:2504.19413 |
| 13 | RAG baseline | 61.0% | J-score | Cloud | - | Mem0 paper |
| 14 | SLM Zero-LLM | 60.4% | Judge | **None** | Yes (MIT) | arXiv:2603.14588 |
| 15 | Mem0 (independent) | ~58% | Judge | Cloud | Partial | Letta blog |

### LongMemEval Scores (where available)

| System | Score | LLM | Source |
|--------|-------|-----|--------|
| Hindsight | 91.4% | Cloud | arXiv:2512.12818 |
| Kumiho | 93.3% (LoCoMo-Plus) | GPT-4o | arXiv:2603.17244 |
| Zep + GPT-4o | 71.2% | GPT-4o | arXiv:2501.13956 |
| Zep + GPT-4o-mini | 63.8% | GPT-4o-mini | arXiv:2501.13956 |
| Full-context GPT-4o | 60.2% | GPT-4o | Zep paper |
| Mem0 | 49.0% | Cloud | arXiv:2603.04814 |

---

## Signet's Position

**Current public benchmark sample:**

| Metric | Signet |
|--------|--------|
| Overall accuracy | **87.5%** |
| Hit@10 | **100%** |
| MRR | **0.615** |
| Sample | **8-question full-stack run** |

**Baseline reference points:** local baseline 36%, cloud baseline 34%.

**Key differentiators not captured by LoCoMo:**
1. Entirely local inference (Ollama qwen3:4b extraction, nomic-embed
   local embeddings). Every system above 74.8% requires cloud LLMs.
2. Adversarial robustness — 80% vs competitors who skip this category
   entirely (Mem0) or score lower than their retrieval categories.
3. Identity persistence, cross-session coherence, skill system,
   predictive scorer — none of which LoCoMo measures.
4. 8-question public sample, not full 1,540. Running the full set is
   still required for credible public claims.

---

## Competitor Profiles

### Tier 1: Claimed SOTA (>89%)

**Kumiho** (arXiv:2603.17244, March 2026)
- Graph-native cognitive memory grounded in formal belief revision (AGM).
- Dual-store: Redis working memory + Neo4j long-term graph.
- Hybrid retrieval: fulltext + vector + graph traversal.
- 97.5% adversarial accuracy — highest published. Natural consequence
  of belief revision: graph contains no fabricated information.
- 93.3% on LoCoMo-Plus (vs best baseline Gemini 2.5 Pro at 45.7%).
- Three innovations: prospective indexing (hypothetical future scenarios
  indexed at write time), event extraction (causal detail preservation),
  client-side LLM reranking (zero-cost revision selection).
- Author's background: VFX pipeline infrastructure. Most architecturally
  similar to Signet's approach.
- Cloud graph server. SDK and MCP plugin open-source.

**EverMemOS** (EverMind/Shanda Group, Dec 2025)
- 93.05% self-reported. No independent reproduction.
- Brain-inspired four-layer system (Agentic + Memory layers).
- Not open source. Backed by TCCI (Chinese tech).

**MemU** (NevaMind-AI, 2026)
- 92.09% on full LoCoMo.
- Hybrid retrieval (semantic + keyword + contextual).
- Memories stored as "coherent, readable documents."
- Open source (GitHub: NevaMind-AI/memU). Cloud API available.

**MemMachine v0.2** (commercial, 2025)
- 91.7% (agent mode), 91.2% (memory mode) with GPT-4.1-mini.
- Per-category: single-hop 94.4%, multi-hop 89.7%, temporal 89.1%.
- 80% token reduction vs Mem0 (4.2M vs 19.2M input tokens).
- Cohere reranking + text-embedding-3-small.
- Not open source. Closed commercial.

**Hindsight** (Vectorize.io, arXiv:2512.12818)
- 89.6% LoCoMo, 91.4% LongMemEval. Peer-reviewed paper.
- Four logical networks: world facts, agent experiences, entity
  summaries, evolving beliefs.
- Three operations: retain, recall, reflect.
- `reflect` synthesizes across memories via LLM (unique capability).
- Open source (MIT). Self-hosted or Vectorize cloud.
- $3.5M raised (April 2024). Built Jerri (internal AI PM).

### Tier 2: Established Players (60-87%)

**SuperLocalMemory V3** (independent research, arXiv:2603.14588)
- Mode C: 87.7% (with cloud synthesis). Mode A: 74.8% (zero cloud).
- 4-channel RRF fusion: Fisher-Rao geometric + BM25 + entity graph
  + temporal.
- EU AI Act compliance-by-architecture angle (data never leaves device).
- MIT licensed. Most competitive local-only system.

**Zep / Graphiti** (arXiv:2501.13956)
- Temporal knowledge graph with bi-temporal validity windows.
- 94.8% DMR, 71.2% LongMemEval (GPT-4o). ~85% LoCoMo (third-party).
- Mem0's replication put Zep at 65.99% J-score on LoCoMo — Zep
  disputes this. True score likely between 65-85%.
- SOC2 Type 2, HIPAA. Credit-based pricing.
- Community Edition deprecated. Must use Zep Cloud or build on Graphiti.

**Letta/MemGPT** (letta.com)
- OS-inspired memory tiers: core (RAM), recall (disk), archival (cold).
- ~83% LoCoMo with full framework. 74% with GPT-4o-mini alone.
- Key insight from their blog: "a simple filesystem with good search
  tools outperforms specialized memory systems."
- $10M seed led by Felicis ($70M post-money). Backed by Jeff Dean.
- Terminal-Bench: 42.5% (4th place overall).

**Engram** (engram.fyi, arXiv:2511.12960)
- 80% LoCoMo, 92% DMR.
- SQLite + sqlite-vec. Single Go binary. Native MCP server.
- "Intelligence at read-time, not write-time." Stores broadly, invests
  compute at query time.
- 776 tokens/query vs 23,423 full-context (96.6% reduction).
- 2,500 npm installs in 5 days. Free personal use, $29/mo hosted.

**Mem0** (mem0.ai, arXiv:2504.19413)
- Self-reported: 66.9% J-score LoCoMo. Independent: ~58%.
- Two-phase pipeline: LLM extraction → semantic dedup (ADD/UPDATE/
  DELETE/NOOP).
- Graph variant (Mem0g) adds entities + relationships. Pro tier only.
- $24M Series A (Oct 2025, Basis Set). YC-backed.
- 48K GitHub stars. Largest community. SOC 2, HIPAA.
- Pricing: Free (10K mem) → $19/mo → $249/mo Pro (graph).
- Explicitly skips adversarial evaluation.

### Tier 3: Emerging / Research

**MAGMA** (2026) — Multi-graph architecture with four orthogonal graph
layers (semantic, temporal, causal, entity). 0.70 J-score. Policy-guided
retrieval traversal. Alternative philosophy: disentangle memory dimensions
into separate graphs vs Signet's unified property graph.

**Cognee** ($7.5M seed, Pebblebed) — Knowledge graph + vector hybrid.
"Chain-of-thought retriever." Claims to outperform Mem0, LightRAG,
Graphiti on HotPotQA but never published specific numerical scores.
70+ companies including Bayer.

**LangMem** (LangChain) — ~51.2% J-score overall. Catastrophically
weak on temporal (23.43 J-score). Three memory types: semantic,
procedural, episodic. Open source SDK.

**AgeMem** (2026) — RL-based LTM/STM management with tool-based
operations and three-stage progressive GRPO training.

---

## Architectural Insights

### Read-time vs Write-time Intelligence

The data strongly suggests investing compute at query time yields
better results than heavy extraction at write time:

- Engram (80%): "store broadly, invest at read time"
- Letta (74-83%): filesystem with good search beats Mem0
- Kumiho (97.5% adv): prospective indexing bridges cue-trigger gap

Signet's DP-6 traversal-primary work moves toward read-time intelligence
(graph walk as primary retrieval). The current full-stack sample
strengthens that direction. Further read-time investment (reranking,
multi-strategy fusion) is the clearest path to closing the gap.

### Graph-Native Architectures Win Adversarial

Systems with graph-native memory (Kumiho 97.5%, Signet 80%) consistently
outperform flat retrieval on adversarial questions. The graph doesn't
contain fabricated information, so there's nothing to hallucinate from.
This is Signet's strongest competitive angle.

### Local vs Cloud: Different Leagues

Every system above 74.8% requires cloud LLMs for either extraction,
embedding, or answer generation. Signet at 87.5% on the current
full-stack sample is competing in a fundamentally different weight
class. The fair comparison is against other local-first systems:

| System | Score | Local? |
|--------|-------|--------|
| SLM V3 Mode A | 74.8% | Yes |
| **Signet** | **87.5%** | **Yes** |
| SLM Zero-LLM | 60.4% | Yes |

### Token Efficiency is Table Stakes

Every competitor claims 80-96% token reduction vs full-context. This is
not a differentiator. Signet should not lead with token efficiency in
positioning.

---

## What Signet Does That Nobody Else Does

None of the benchmarked systems provide:
1. **Identity persistence** — SOUL.md, IDENTITY.md, cross-platform
   agent identity
2. **Cross-session coherence** — session summaries, working memory,
   context continuity
3. **Skill system** — portable, installable agent capabilities
4. **Predictive scorer** — 370K-parameter model learning which memories
   matter
5. **Decentralized ownership** — all data in ~/.agents/, user-owned
6. **Multi-platform connectors** — Claude Code, OpenCode, OpenClaw,
   Cursor via MCP
7. **Knowledge architecture** — entities, aspects, attributes,
   communities, dependency graph

LoCoMo measures retrieval accuracy on one axis of a much broader value
proposition. The competitive positioning should emphasize the full
cognitive persistence platform, not just memory QA scores.

---

## Deep Dive: Kumiho (arXiv:2603.17244)

Most architecturally aligned competitor. Written by Young Bin Park
(support@kumiho.io), whose background is in VFX pipeline infrastructure
— same domain as Signet's creator. Published March 18, 2026. 56 pages.

### Architectural Parallels

| Concept | Kumiho | Signet |
|---------|--------|--------|
| Graph store | Neo4j property graph | SQLite entity graph (entities, aspects, attributes, dependencies) |
| Working memory | Redis | MEMORY.md + session context injection |
| Retrieval | Fulltext + vector + graph traversal | FTS5 BM25 + vector + graph traversal (DP-6) |
| Entity resolution | LLM extraction → graph nodes | Pipeline extraction → entity table + FTS5 entity index |
| Community detection | Not mentioned | Louvain algorithm (DP-5, graphology-communities-louvain) |
| Belief revision | Formal AGM postulates (K*2-K*6, Relevance, Core-Retainment) | Retention decay + conflict resolution (informal) |
| Versioning | Immutable revisions + mutable tag pointers | Memory updates with content_hash tracking |
| Adversarial robustness | 97.5% (graph contains no fabricated data) | 80% (same principle — graph walks real entity relationships) |
| Asset management | Unified: same graph manages memories AND agent work products | Separate: memory graph + skills + identity files |
| Identity persistence | Not addressed | Core feature (SOUL.md, IDENTITY.md, cross-platform connectors) |
| Local inference | No (requires GPT-4o for extraction, answer) | Yes (Ollama qwen3:4b extraction, nomic-embed local) |
| MCP support | Python SDK + MCP plugin (open source) | Native MCP server in daemon |
| Pricing model | Cloud graph server (kumiho.io) | Self-hosted, user-owned data in ~/.agents/ |

### Key Insight: Unified Memory + Asset Graph

Kumiho's core architectural claim is that cognitive memory primitives
(immutable revisions, typed edges, URI addressing) are *identical* to
what you need for managing agent-produced work outputs (code, designs,
documents). So they built one graph that serves both purposes: agents
use it to remember AND to version/locate/build-upon each other's
outputs. This is relevant to Signet's multi-agent roadmap.

### Three Techniques Worth Adopting

**1. Prospective Indexing (write-time future-scenario generation)**

At write time, an LLM generates hypothetical future queries that would
need this memory and indexes those alongside the actual content. This
bridges the semantic gap between how information is stored and how it's
later searched.

Example: storing "Alice moved from backend to lead ML platform
migration" also indexes hypothetical queries like "who is working on
ML?", "what organizational changes happened?", "who left the backend
team?" — even though those exact phrases never appear in the memory.

This directly addresses Signet's retrieval weakness on single-hop (30%)
and world-knowledge (50%) categories. The cue-trigger semantic
disconnect is why keyword search misses memories that use different
terminology than the query.

**Implementation path for Signet:** Add a pipeline stage after extraction
that generates 3-5 hypothetical retrieval queries per memory and indexes
them in the FTS5 table. Cost: one additional LLM call per memory at
write time. The prospective queries become additional searchable content
without modifying the memory itself.

**2. Event Extraction (causal structure preservation)**

Standard memory summarization flattens causality. "Meeting decided to
delay Q4 launch because vendor X missed the API deadline" becomes just
"Q4 launch delayed." Event extraction preserves the structured causal
chain: `{event: "launch delay", cause: "vendor X API deadline miss",
consequence: "Q4 timeline shift", actors: ["vendor X"]}`.

This matters for multi-hop questions ("Why was Q4 delayed?" requires
connecting the delay to the vendor miss) and temporal reasoning ("When
did the vendor problem start affecting timelines?").

**Implementation path for Signet:** Extend the extraction prompt to
output structured events alongside memories. Store as entity attributes
with `type: "event"` and aspect relationships linking cause → effect.
The knowledge graph already has the schema for this (entity_dependencies
with typed edges).

**3. Client-Side LLM Reranking (zero-cost revision selection)**

When retrieving memories, instead of server-side reranking (which adds
latency and cost), Kumiho returns structured metadata about multiple
candidate revisions and lets the consuming agent's own LLM select the
most relevant one. The agent is already making an LLM call to process
the retrieved context — the reranking happens within that same call at
zero additional inference cost.

**Implementation path for Signet:** In the MCP memory_search response,
include confidence/provenance metadata per result. The consuming agent
(Claude, OpenClaw, etc.) naturally weighs results with richer metadata.
This is partially implemented — constructed memories already include
entity context. Extending it to all results with source channel
(traversal vs flat) and structural importance scores would give the
consuming agent better signal.

### Kumiho's Weaknesses (Signet's Advantages)

1. **No local inference.** Requires GPT-4o for extraction and answers.
   Total evaluation cost ~$14 for 401 entries. Signet runs free on
   local Ollama.

2. **No identity layer.** No equivalent to SOUL.md, IDENTITY.md,
   USER.md. No cross-platform agent identity. No personality
   persistence.

3. **Cloud-dependent graph.** Neo4j + Redis means infrastructure.
   Signet's SQLite runs anywhere with zero dependencies.

4. **No predictive scoring.** No equivalent to the 370K-parameter
   cross-attention model learning which memories matter from agent
   feedback signals.

5. **No skill system.** No portable, installable agent capabilities.

6. **Single author, single company.** Kumiho Inc. vs Signet's growing
   contributor base and multi-connector ecosystem.

7. **Neo4j operational burden.** Production Neo4j is non-trivial to
   run. SQLite is zero-config.

### Assessment

Kumiho validates Signet's architectural direction. Graph-native memory
with entity resolution and typed relationships is the winning approach
for adversarial robustness and multi-hop reasoning. The 97.5%
adversarial score proves what Signet's 80% already suggests: when the
graph contains only real entity relationships, there's nothing to
hallucinate from.

The three techniques (prospective indexing, event extraction,
client-side reranking) are directly adoptable without architectural
changes. Prospective indexing alone could significantly close the
single-hop and world-knowledge gap.

The key strategic difference: Kumiho is a memory system. Signet is a
cognitive persistence platform. Memory retrieval is one axis of a much
broader value proposition that includes identity, skills, prediction,
and sovereignty. Kumiho will never compete on those axes.

---

## Action Items

### Benchmarking

1. **Run full 1,540-question LoCoMo** on separate database for credible
   public numbers beyond the current 8-question sample.
2. **Run head-to-head comparisons** using memorybench providers (mem0,
   zep, supermemory already wired up).
3. **Add Engram provider** to memorybench — most architecturally
   comparable (SQLite, MCP-native).
4. **Consider cloud LLM mode** for benchmark runs — would show what
   Signet achieves with the same LLM budget as competitors.
5. **Publish adversarial results prominently** — this is where
   graph-native architectures shine and most competitors don't even
   measure.

### Retrieval Improvements (informed by competitive analysis)

6. **Prospective indexing** — generate hypothetical future queries at
   write time and index alongside memory content. Highest-impact
   technique from Kumiho. Directly addresses single-hop (30%) and
   world-knowledge (50%) weakness.
7. **Event extraction** — preserve causal structure in memories instead
   of flattening to narrative. Addresses multi-hop reasoning.
8. **Client-side reranking metadata** — include source channel
   (traversal/flat), structural importance, and provenance in
   memory_search MCP response so consuming agents can self-rerank.
9. **Read-time compute investment** — Engram and Letta both prove that
   query-time intelligence beats write-time extraction. Continue DP-6
   direction. Consider multi-strategy parallel retrieval (Hindsight
   runs 4 strategies in parallel).

### Competitive Intelligence

10. **Monitor Kumiho** — most aligned competitor. Track kumiho.io
    launches, SDK updates, pricing changes.
11. **Track LoCoMo-Plus** adoption — if this becomes the standard
    benchmark, all current scores become irrelevant. Signet's graph
    architecture should perform well on implicit constraint recall.
12. **SuperLocalMemory V3** — closest local-only competitor at 74.8%.
    Their 4-channel RRF fusion (Fisher-Rao + BM25 + entity + temporal)
    is worth studying.

---

## Sources

- Mem0 paper: arXiv:2504.19413
- Mem0 blog: mem0.ai/blog/benchmarked-openai-memory-vs-langmem-vs-memgpt-vs-mem0
- Letta blog: letta.com/blog/benchmarking-ai-agent-memory
- Zep paper: arXiv:2501.13956
- Engram paper: arXiv:2511.12960
- Engram research: engram.fyi/research
- Hindsight paper: arXiv:2512.12818
- Kumiho paper: arXiv:2603.17244
- SuperLocalMemory paper: arXiv:2603.14588
- MemU benchmark: memu.pro/benchmark
- DEV Community comparison: dev.to/varun_pratapbhardwaj_b13/5-ai-agent-memory-systems-compared
- Vectorize comparison: vectorize.io/articles/best-ai-agent-memory-systems
- Awesome Agent Memory: github.com/TeleAI-UAGI/Awesome-Agent-Memory
- LoCoMo benchmark: snap-research.github.io/locomo

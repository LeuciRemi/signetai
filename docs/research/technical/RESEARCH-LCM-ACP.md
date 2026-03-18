---
title: "Research: LCM & ACP"
description: "Research notes on Lossless Context Management, acpx, and lossless-claw."
section: "Research"
order: 90
question: "How can Large Concept Models and Agent Communication Protocols inform Signet's memory pipeline?"
informs: ["knowledge-architecture-schema", "desire-paths-epic"]
---

# Research: Lossless Context Management & Agent Client Protocol

> Research notes on LCM, acpx, and lossless-claw. Collected 2026-03-08.
> References cloned to `references/acpx/` and `references/lossless-claw/`.
>
> **This research produced two specification documents:**
> - `docs/specs/planning/LCM-PATTERNS.md` — Five patterns adapted for Signet's memory architecture
> - `docs/ACP-INTEGRATION.md` — Phased integration plan for acpx and ACP
> - `docs/specs/planning/DESIRE-PATHS.md` — Updated with LCM foundation section

---

## Sources

| Source | Type | URL |
|--------|------|-----|
| LCM Paper | Academic (Voltropy PBC) | https://papers.voltropy.com/LCM |
| lossless-claw | OpenClaw Plugin | https://github.com/Martian-Engineering/lossless-claw |
| acpx | CLI Tool | https://github.com/openclaw/acpx |
| Shannon Lecture | Historical Reference | 1952 Bell Labs, "Creative Thinking" |

---

## LCM: Lossless Context Management

**Authors**: Clint Ehrlich, Theodore Blackman (Voltropy PBC, Feb 14 2026)

### Core Thesis

Context windows are the bottleneck for long-horizon agentic sessions. Even
1M+ token windows are insufficient for multi-day sessions where file contents,
tool calls, and intermediate reasoning accumulate. Performance degrades well
before the nominal limit ("context rot").

RLM (Recursive Language Models) proved that *active* context management
outperforms passive windows. But RLM gives the model full autonomy over its
memory via symbolic recursion (writing Python scripts to chunk/manage context).
This is flexible but stochastic -- an efficient chunking script in one rollout
may be suboptimal in the next.

LCM takes the opposite approach: the *engine* manages memory deterministically,
using structured primitives the model invokes. The analogy is GOTO vs structured
programming -- GOTO is maximally flexible but error-prone; `for`/`while`/`if`
are constrained but reliable.

### Architecture

**Dual-state memory**:
- **Immutable Store**: Every user message, assistant response, and tool result
  persisted verbatim. Never modified. Source of truth.
- **Active Context**: The window actually sent to the LLM. Mix of recent raw
  messages and precomputed summary nodes (materialized views over history).

**Hierarchical DAG**:
- Leaf summaries (depth 0): condensed versions of raw message chunks
- Condensed nodes (depth 1+): higher-order summaries merging lower nodes
- Parent links enable drill-down to original content via `lcm_expand`
- Stored in persistent transactional backend (reference impl uses PostgreSQL)

**Context Control Loop** (Algorithm 2 from paper):
1. New item arrives -> persist to immutable store, append pointer to active context
2. If `Tok(C) > tau_soft`: trigger async compaction (non-blocking)
3. While `Tok(C) > tau_hard`: blocking compaction of oldest block

**Three-Level Summarization Escalation** (guaranteed convergence):
1. Normal: LLM summarize with `mode="preserve_details"`, target T tokens
2. Aggressive: LLM summarize with `mode="bullet_points"`, target T/2
3. Deterministic truncation to 512 tokens (no LLM involved)

If any level produces output smaller than input, return it. Level 3 always
converges. This eliminates "compaction failure" where summaries expand.

### Key Properties

**Zero-Cost Continuity**: Below `tau_soft`, no summarization or retrieval
occurs. System is a passive logger. No latency penalty for short tasks.

**Deterministic Retrievability**: When compacting, engine inserts message IDs
into summaries. Any prior message is recoverable via `lcm_expand`, regardless
of how many compaction rounds occurred. Model doesn't need to know compaction
happened -- it just sees summary text annotated with expandable identifiers.

**Scope-Reduction Invariant**: When sub-agent spawns sub-agent, it must declare
`delegated_scope` and `kept_work`. If it can't articulate what it's retaining
(i.e., would delegate everything), engine rejects the call. This structurally
prevents infinite delegation without depth limits.

### Large File Handling

Files exceeding 25k tokens are not loaded into context. Instead:
- Stored externally with an opaque ID
- Type-specific "Exploration Summary" generated (schema extraction for
  JSON/CSV/SQL, function signatures for code, LLM summary for text)
- Compact reference inserted into active context
- File IDs propagate through DAG -- model retains awareness across compactions

### Tools Exposed

**Memory-Access** (read-only, immutable store):
- `lcm_grep(pattern, summary_id?)` -- regex search across full history
- `lcm_describe(id)` -- metadata for any LCM identifier (file or summary)
- `lcm_expand(summary_id)` -- expand summary back to constituent messages
  (restricted to sub-agents only, prevents context flooding in main loop)

**Operators** (parallel data processing):
- `llm_map(input_path, prompt, output_schema, concurrency)` -- stateless
  per-item LLM calls, engine handles iteration/retries/validation
- `agentic_map(...)` -- spawns full sub-agent session per item, for multi-step
  reasoning. Supports `read_only` flag.

**Delegation** (sub-agent management):
- `Task(prompt, delegated_scope, kept_work)` -- spawn sub-agent with
  scope-reduction guard
- `Tasks(tasks[])` -- parallel sub-agent dispatch

### Benchmark Results (OOLONG)

Volt (LCM on OpenCode fork) vs Claude Code, both using Opus 4.6 + Haiku 4.5:

| Context | Claude Code | Volt | Gap |
|---------|-------------|------|-----|
| 8K | +13.1 | +11.2 | CC +1.9 |
| 16K | +26.3 | +25.0 | CC +1.3 |
| 32K | +25.8 | +29.4 | Volt +3.6 |
| 65K | +26.8 | +27.6 | Volt +0.8 |
| 131K | +22.0 | +28.3 | Volt +6.3 |
| 256K | +8.5 | +18.5 | Volt +10.0 |
| 512K | +29.8 | +42.4 | Volt +12.6 |
| 1M | +47.0 | +51.3 | Volt +4.3 |

Average: Volt 74.8 vs CC 70.3. Gap widens at longer contexts where LCM's
deterministic map-reduce shines vs CC's model-driven chunking strategies.

---

## acpx: Agent Client Protocol CLI

Headless CLI enabling structured agent-to-agent communication via ACP.
Replaces terminal output scraping with protocol-based interaction.

### Architecture

- Session state in `~/.acpx/`
- Routes prompts by walking to nearest git root
- Adapters for: Codex, Claude Code, Gemini, OpenClaw, OpenCode, Pi
- Custom ACP servers via `--agent` escape hatch

### Key Features

- Persistent multi-turn sessions surviving crashes
- Named parallel sessions per repository
- Prompt queueing with ordered execution
- Fire-and-forget (`--no-wait`)
- Cooperative cancellation via `session/cancel`
- Output modes: text (default), NDJSON streaming, JSON-strict, quiet
- Configurable idle TTLs, auto-respawn with `session/load` fallback

### Configuration

Global: `~/.acpx/config.json`
Project: `.acpxrc.json`
Auth credentials stored in config. Custom agents registered with command overrides.

**Status**: Alpha. CLI and runtime interfaces may change.

---

## lossless-claw: LCM Plugin for OpenClaw

Reference implementation of LCM as an OpenClaw plugin. Replaces default
sliding-window truncation with DAG-based hierarchical summarization.

### Storage

SQLite at `~/.openclaw/lcm.db`. FTS5 optional for full-text search acceleration.

### Compaction

- Triggered at configurable threshold (default 75% of window)
- Fresh tail protected (default 32 messages stay raw)
- Depth-aware prompts: leaf summaries emphasize narrative detail, higher depths
  focus on goals and decisions

### Agent Tools

- `lcm_grep`: full-text + regex across messages/summaries
- `lcm_describe`: retrieve specific summaries or stored files by ID
- `lcm_expand_query`: delegated sub-agent expansion with semantic search
- `lcm_expand`: low-level DAG expansion for sub-agents

---

## Relevance to Signet

### Pattern Overlap

| Concept | LCM | Signet |
|---------|-----|--------|
| Persistent store | Immutable message history | Entity/mention graph + memory table |
| Summarization | Hierarchical DAG of summaries | Memory extraction pipeline |
| Retrieval | lcm_grep + lcm_expand | Hybrid vector + keyword search |
| Scope | Within single session | Across all sessions |
| File handling | Exploration summaries | Document pipeline (planned) |
| Sub-agent guard | Scope-reduction invariant | N/A (potential addition) |

### Ideas Worth Exploring

1. **Three-level escalation for memory extraction**: Signet's extraction pipeline
   could adopt the guaranteed-convergence pattern. If normal extraction produces
   too many entities, escalate to aggressive mode, then deterministic fallback.
   Directly relevant to entity bloat problem.

2. **Scope-reduction invariant for signet scheduler**: When scheduler spawns
   agents, requiring them to declare delegated vs retained scope could prevent
   runaway task chains. Maps to the `Bun.spawn` scheduler pattern.

3. **DAG-based session summarization**: Instead of flat memory records per
   session, build a summary DAG that allows drill-down. Would improve the
   "what happened three sessions ago" retrieval problem.

4. **acpx as agent coordination layer**: Replace raw process spawning in
   scheduler with ACP protocol. Gets session management, crash recovery,
   cancellation, and structured output for free.

5. **Operator-level recursion (llm_map/agentic_map)**: The pattern of
   engine-managed parallel processing with schema validation and retry is
   applicable to signet's batch operations (e.g., entity reconciliation,
   bulk memory re-embedding).

6. **Zero-cost continuity principle**: Signet's daemon overhead should be
   zero when not needed. Memory pipeline should be invisible until context
   demands active management. Currently close to this but worth auditing.

### What LCM Doesn't Solve (That Signet Does)

- Cross-session memory persistence and identity
- Knowledge graph with entity relationships
- Predictive memory scoring (anticipating what's relevant)
- Agent identity and personality continuity
- Multi-agent coordination beyond sub-agent delegation

---

## Shannon: "Creative Thinking" (1952)

Included as foundational reference for how we think about problem-solving
in agent design. Full lecture by Claude Shannon at Bell Labs, March 20, 1952.

### The Uranium Metaphor (via Turing)

Human brains are like uranium. Shoot in a neutron (idea) -- some people return
half a neutron. Others are past critical mass and return two for every one.
Those people are past the "knee of the curve." A tiny fraction of the population
produces a disproportionate share of important ideas.

### Three Requirements for Creative Work

1. **Training & experience** -- domain knowledge is prerequisite
2. **Intelligence** -- above-average cognitive capacity needed for research
3. **Motivation** -- the differentiator. Drive to find answers, curiosity about
   how things work. "Either you have it or you don't" (Fats Waller on swing).

The surface composition of motivation:
- **Curiosity**: wanting to know how things work
- **Constructive dissatisfaction**: "this works, but I think it can be done
  more elegantly." A persistent itch when things aren't quite right.
- **Pleasure of solution**: the raw excitement of proving a theorem or finding
  a clever circuit design

### Thinking Techniques

1. **Simplification**: Strip to essentials. Solve the simple version. Add
   refinements back toward the original problem.

2. **Analogy**: Find similar solved problem P' with solution S'. Map the
   analogy from P'->P and S'->S. "Two small jumps are easier than one big one."

3. **Restatement**: Reformulate from every angle. Prevents mental ruts. Often
   an outsider solves instantly what you've struggled with for months.

4. **Generalization**: The moment you solve something, ask "can I make a broader
   statement?" Extend from specific to general, 2D to N-dimensional.

5. **Structural analysis**: Break big leaps into subsidiary steps. Prove lemmas.
   Many proofs found through "extremely circuitous processes" then simplified.

6. **Inversion**: Flip the problem. Assume the solution is given, try to derive
   the premises. Shannon built a nim-playing machine this way -- the machine
   worked backward from desired output via feedback until matching input.

### Application to Agent Design

These techniques map directly to how we design agent reasoning:
- Simplification -> decompose complex tasks before attempting
- Analogy -> leverage prior solutions in knowledge graph
- Restatement -> multiple retrieval strategies for same query
- Generalization -> extract reusable patterns from specific solutions
- Structural analysis -> break work into sub-agent tasks
- Inversion -> work backward from desired output to required inputs

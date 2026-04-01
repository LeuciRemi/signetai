---
title: "Dreaming: Token-Budget Memory Consolidation"
description: "Replace granular pipeline workers with periodic smart-model reasoning passes that consolidate session summaries into a dense, accurate knowledge graph."
order: 1
section: "Memory Architecture"
informed_by:
  - "docs/specs/planning/LCM-PATTERNS.md"
  - "docs/specs/complete/memory-pipeline-plan.md"
  - "docs/specs/complete/knowledge-architecture-schema.md"
success_criteria:
  - "Entity graph density increases (fewer entities, more attributes per entity) after a dreaming pass"
  - "Duplicate and near-duplicate entities are merged automatically"
  - "Stale or junk attributes are pruned without manual intervention"
  - "Users without large-model access fall back to the existing extraction pipeline with no degradation"
  - "Token spend per dreaming pass is bounded and configurable"
scope_boundary: "This spec covers the consolidation agent, trigger mechanism, and backfill strategy. It does not cover changes to the session capture system (transcripts, summaries) which remains as-is, nor does it cover the system prompt extraction from AGENTS.md (separate spec)."
---

Dreaming: Token-Budget Memory Consolidation
============================================

*Let a smart model reason about your day instead of making dumb workers
guess at it piece by piece.*


## Problem

The current memory pipeline runs small, context-limited workers that
process individual transcript chunks in isolation. Each worker sees a
narrow slice — one chunk, one fact candidate — and cannot reason across
the full picture. The results:

- **Entity bloat.** The knowledge graph fills with duplicate and
  near-duplicate entities because no single worker sees enough context
  to recognize that "Nuke compositing" and "Foundry Nuke" refer to the
  same thing.
- **Junk attributes.** Short fragments, broken index entries, and
  decontextualized snippets survive as attributes because the quality
  gate (MIN_FACT_LENGTH=80, confidence threshold) is a blunt instrument
  that can't assess semantic value.
- **Weak graph traversal.** The knowledge graph's traversal scoring
  is dominated by hub entities (high-degree nodes like the user's own
  name) rather than topically relevant nodes, because the graph
  structure itself is noisy.
- **Compounding complexity.** Every attempt to fix these problems adds
  another stage to the pipeline (reranker, contradiction checker,
  dedup pass, significance gate), making the system harder to maintain
  without proportionally better results.

Meanwhile, session summaries produced by the summary-worker are
already good. The LCM lineage system captures coherent session-level
artifacts. The raw material is fine — it's the processing that's the
bottleneck.


## Core Idea

Replace the granular extract-decide-write-embed pipeline with periodic
**dreaming passes**: a single smart-model reasoning step that reads
accumulated session summaries and the current entity graph, then
produces a set of graph mutations (create, merge, update, delete,
supersede).

The metaphor is deliberate. Biological memory consolidation happens
during sleep — the brain replays the day's experiences and integrates
them into long-term memory. Dreaming does the same thing for Signet:
replay the sessions, reason about what matters, and write it into the
graph cleanly.


## Architecture

### What stays

- **Session capture.** Transcripts and summaries continue to be
  written by the existing summary-worker. The LCM artifact system
  (`writeImmutableArtifact`) is unchanged.
- **The knowledge graph schema.** Entities, aspects, attributes —
  the data model is good. The problem is the writer, not the schema.
- **The extraction pipeline (as fallback).** Users who don't want to
  spend tokens on a large model keep the existing pipeline. It becomes
  the "local/free" tier of memory maintenance. Dreaming is the
  "premium" tier.

### What changes

- **Dreaming agent.** A new background job that runs a reasoning pass
  over accumulated session summaries. It reads the current entity
  graph, identifies what changed, and produces structured mutations.
- **Token-budget trigger.** Dreaming is triggered by accumulated
  summary tokens, not by a fixed schedule. Once unprocessed summaries
  cross a configurable threshold (default: ~100k tokens), a dreaming
  job is queued.
- **Backfill / compaction mode.** A one-time (or on-demand) variant
  that reads the full entity graph and densifies it — merging
  duplicates, pruning junk, collapsing near-identical attributes.
  Same agent, different scope.


## Trigger Mechanism

The daemon tracks accumulated summary tokens since the last dreaming
pass. This is a simple counter: each time a session summary is written,
its token count is added to a running total persisted in the database.

```
dreaming_state:
  tokens_since_last_pass: 0
  last_pass_at: null
  last_pass_summary_id: null
```

When `tokens_since_last_pass` exceeds the configured threshold, the
daemon queues a dreaming job. The threshold is configurable in
`agent.yaml`:

```yaml
memory:
  dreaming:
    enabled: true
    tokenThreshold: 100000    # trigger after ~100k tokens of summaries
    provider: "anthropic"     # which LLM provider to use
    model: "claude-sonnet-4-6"  # default model for dreaming passes
    maxInputTokens: 128000    # context budget per pass
    backfillOnFirstRun: true  # run compaction on first dreaming pass
```

This means:
- Heavy user (many sessions/day): dreams nightly or more often
- Light user (few sessions/week): dreams weekly or less
- Scales naturally with actual usage, not wall-clock time


## Dreaming Agent Contract

### Identity

The dreaming agent is not an anonymous data processor. It is the same
agent — with full identity context — taking time to reflect on its
own experiences. It receives the complete identity stack:

- `AGENTS.md` — operating instructions
- `SOUL.md` — personality, values, temperament
- `IDENTITY.md` — who the agent is
- `USER.md` — who the user is and how to relate to them

This matters because memory consolidation requires judgment about
*what matters to this agent and this user*. An isolated worker can't
make that call. The agent reasoning about its own day — knowing who
it is, who the user is, what it cares about — can.

### Dreaming is a normal session

This is the critical design insight: **a dreaming pass is just a
regular Signet session.** It goes through the same session-start
hook, the same transcript capture, the same summarization at session
end. The agent receives MEMORY.md as part of its context, just like
any other session. The dreaming session's transcript and summary are
saved like any other session's.

This means:

- **The agent remembers dreaming.** The next dreaming pass can review
  what the previous one did — what it merged, what it pruned, what
  decisions it made — and course-correct. "Last time I was too
  aggressive pruning entities related to VFX projects. I should be
  more conservative there."
- **MEMORY.md provides continuity.** The dreamer doesn't approach the
  graph cold. It has its working memory of recent activity, priorities,
  and the state of things from the last time it reflected.
- **Self-improvement is emergent.** Because the agent can observe its
  own prior dreaming sessions, it can evaluate its own performance.
  "I merged these entities last time but the search results got worse.
  I should have kept them separate." The feedback loop tightens
  naturally.
- **No special infrastructure.** The daemon doesn't need a separate
  session type, a separate transcript store, or a separate summary
  pipeline for dreaming. It's the same code path. The only difference
  is what triggers the session and what the initial prompt says.

The dreaming prompt is simple:

> You're taking some time to reflect on your recent sessions. Here
> are the session summaries since your last reflection. Here is your
> current knowledge graph. Please review what happened, what you
> learned, and update your memory accordingly.

That's it. The agent's identity, working memory, and judgment handle
the rest.

### Input

The dreaming agent receives (via normal session-start hook):

1. **Full identity context** — AGENTS.md, SOUL.md, IDENTITY.md,
   USER.md, MEMORY.md. The complete identity stack, same as any
   session. The agent needs to know who it is, what it's been doing,
   and what the current state of its memory looks like.
2. **Unprocessed session summaries** — all summaries written since the
   last dreaming pass, ordered chronologically. These are the session
   DAG nodes at depth 0 with `kind = "session"`.
3. **Current entity graph snapshot** — all entities with their aspects
   and attributes, plus relationship edges. This is the agent's view
   of existing long-term memory.
4. **A brief task prompt** — telling the agent to reflect on the
   sessions and update the graph. No elaborate instructions — the
   agent's own identity and judgment handles the rest.

### Self-Improvement Loop

Because dreaming sessions are normal sessions that get summarized and
stored, a natural self-improvement cycle emerges:

1. **Dream pass N** — agent reviews sessions, updates graph, makes
   judgment calls about what to merge/prune/keep.
2. **Dream pass N is summarized** — the dreaming session's transcript
   and decisions become part of the agent's history.
3. **Dream pass N+1** — agent sees the summary of dream pass N in its
   session history. It can evaluate: did those merges make retrieval
   better? Did pruning go too far? Were the right things prioritized?
4. **Adjustments compound** — the agent refines its approach to memory
   management over time, based on observing its own results.

This replaces the current model where pipeline workers repeat the
same mistakes indefinitely because they have no memory of prior
passes and no ability to self-evaluate.

### Output

A structured JSON response containing graph mutations:

```typescript
interface DreamingResult {
  mutations: Array<
    | { op: "create_entity"; name: string; type: string; aspects: Aspect[] }
    | { op: "merge_entities"; source: string[]; target: string; reason: string }
    | { op: "delete_entity"; name: string; reason: string }
    | { op: "update_aspect"; entity: string; aspect: string; attributes: Attribute[] }
    | { op: "delete_aspect"; entity: string; aspect: string; reason: string }
    | { op: "supersede_attribute"; entity: string; aspect: string; old: string; new: string }
    | { op: "create_attribute"; entity: string; aspect: string; content: string }
    | { op: "delete_attribute"; entity: string; aspect: string; content: string; reason: string }
  >;
  summary: string;       // human-readable summary of what changed
  tokensBudget: number;  // tokens consumed by this pass
}
```

The daemon validates and applies mutations transactionally. Failed
or invalid mutations are logged but don't block the rest.

### Chunking strategy

If accumulated summaries exceed `maxInputTokens`, the agent processes
them in chronological batches. Each batch gets the full entity graph
snapshot (or the graph as mutated by the previous batch) plus a window
of summaries. The entity graph is the continuity thread across batches.


## Backfill / Initial Compaction

On first run (or on-demand via API/CLI), dreaming runs in compaction
mode:

1. Load the full entity graph (entities + aspects + attributes)
2. Load a sample of recent session summaries for context
3. Reason about the graph: find duplicates, merge them, prune junk
   attributes, collapse redundant aspects
4. Output the same mutation format

This is how we clean up existing bloated databases. It's the same
agent with a different input emphasis: graph-heavy instead of
summary-heavy.

A CLI command triggers it explicitly:

```bash
signet dream --compact    # run compaction now
signet dream --status     # show dreaming state
signet dream --trigger    # force a dreaming pass now
```


## Interaction with Existing Pipeline

The extraction pipeline and dreaming are not mutually exclusive:

| Config                          | Behavior                                                        |
|---------------------------------|-----------------------------------------------------------------|
| `dreaming.enabled: false`       | Extraction pipeline only (current behavior, default)            |
| `dreaming.enabled: true`        | Dreaming runs on token threshold; pipeline still handles        |
|                                 | immediate fact extraction for real-time recall                  |
| `pipeline.extractionEnabled: false` + `dreaming.enabled: true` | Dreaming only — summaries accumulate, no real-time extraction |

The pipeline can remain active for immediate fact availability (users
want to recall something from 5 minutes ago, not wait for the next
dreaming pass). Dreaming then cleans up and densifies what the
pipeline produced. Over time, as models improve and context windows
grow, users may choose to disable the pipeline entirely and rely on
dreaming + raw transcript retrieval.


## System Prompt Extraction (Related)

This is a separate concern but was identified in the same
conversation: the Signet system prompt currently lives inside
`AGENTS.md`, which means it's never re-injected if the user already
has a custom `AGENTS.md`. The fix:

- **Remove the Signet system prompt from AGENTS.md generation.**
- **Inject it as a prefix in the session-start hook.** This keeps it
  independent of the user's identity files.
- **The system prompt should explain the LCM expand tool** (possibly
  renamed to something more intuitive like "memory search" or
  "session recall") and encourage models to use it as the primary
  memory interface.

This is tracked separately but is part of the same simplification
effort.


## Open Questions

1. **Model selection for dreaming.** Should this default to the same
   provider as extraction, or always target a larger model? The whole
   point is that a smarter model does better work, but cost varies.
2. **Mutation conflict resolution.** If dreaming says "merge entity A
   and B" but entity B was updated by the pipeline between when the
   snapshot was taken and when mutations are applied, what wins?
3. **Observability.** Users should be able to see what dreaming
   changed — a diff view of the entity graph before/after. Dashboard
   integration?
4. **Incremental vs full graph snapshot.** Sending the full entity
   graph every pass could get expensive for large databases. Should
   we send only entities that were touched by the new session summaries
   (plus their neighbors)?
5. **Retention policy interaction.** Dreaming's delete operations need
   to respect pinned memories and retention policies. How does this
   compose with the existing retention decay system?

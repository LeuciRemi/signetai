Vision
======

This document describes what Signet is, what it is not, and where it is
heading. It is written for two audiences: people evaluating Signet
today, and people who want to know what we're actually building toward.
The two are separated deliberately — shipped product first, long arc
second.

Project overview and developer docs: [`README.md`](README.md)
Near-term priorities: [`ROADMAP.md`](ROADMAP.md)
Architecture: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)

---

## What Signet is today

Signet is a local-first memory and context layer for AI agents. It
preserves the raw artifacts of a person's work — transcripts, notes,
documents, decisions, source clippings — as ground truth, and builds a
semantic layer on top with provenance chains back to those artifacts.
Memory, identity, skills, and secrets travel with the user across
machines, models, and harnesses instead of being trapped inside any one
of them.

The product is portability and durability, not intelligence. Models get
smarter on their own. What they cannot do for themselves is carry a
person's context forward without flattening it: a context-compacted
session that drops a durable preference, a research note whose source
date is lost, a delegated action whose rationale cannot be recovered.
Signet is the boring infrastructure that makes that possible.

Three layers. Everything else is maintenance.

- **Artifacts** are ground truth. Transcripts, source notes, saved
  memories, imported documents. Immutable, episodic, source-backed.
- **Semantics** are cheap shortcuts derived from artifacts, with
  provenance chains back to the artifact that justifies them. Old
  claims get superseded. The semantic layer is constantly being
  rebuilt.
- **Query** is just the interface. Recall, search, graph navigation,
  hooks. Nothing in the query layer is fundamentally better than
  reading the artifact directly; it exists to make retrieval cheap.

Maintenance runs as a dreaming loop: passes that read recent artifacts,
extract what matters, supersede what is stale, and propose small
evidence-backed changes to identity files, skills, and the semantic
layer. Continuity is not a feature that ships once. It is an operating
substrate that is maintained.

And one capability is already further along than the rest: **secrets**.
Signet gives agents measured access to credentials without ever
exposing raw values — the daemon holds them, injects them at execution
time, and redacts them from everything downstream. This is the shape
the rest of the vision generalizes.

### What we ship in 2026

- A desktop app and a dashboard a non-developer can use, alongside the
  headless installs developers already have.
- One memory engine: a single ingest queue that both pipeline
  distillation and agentic dreaming read from, writing the same graph
  operations.
- Temporal claims that age gracefully, and recall that reads the full
  ontology.
- Benchmarks as receipt, not pitch — recall quality verified on shared
  eval harnesses, with methodology attached, not self-invented numbers.
- A daemon that is boring: no crash loops, no silent backlogs, repair
  tools that tell the truth.

## The long arc

AI is becoming the interface to a person's life. The frontier products
already show what that looks like: connect your calendar, your files,
your email, your health data, your finances, and the assistant gets
dramatically more useful. Every one of those connections moves custody
of the data to the provider. The usefulness is real; so is the trade.

We don't think the trade is necessary.

The endgame for Signet is a secure personal database that sits between
a person and every AI they use — with the plumbing to grant measured,
revocable, provenance-backed access to the data in it. Role-based
access control for AI over your life, operated by you. The secrets
system is the proof of concept: an agent can *use* a credential without
ever *seeing* it. Apply that same shape to health records, finances,
private writing, relationships — the whole ontology — and a person can
get the real benefits of an AI that knows them without handing custody
to anyone.

That is the direction memory points once it's solved. An agent that
remembers everything about you is only acceptable if the memory is
yours — stored where you can read it, delete it, and take it elsewhere.
Signet builds the memory layer first because it's the hard technical
core, and because every harness needs it today. The vault is what the
memory layer becomes.

What this implies, concretely, over time:

- **Measured access beyond secrets.** Scope, expire, and revoke what
  any agent or harness can read, down to the claim level — the same
  way secrets already work for credentials.
- **Authority artifacts for delegated action.** Intent → evidence →
  approval → result, reconstructable. When an agent acts for you, the
  record of what it was allowed to do, and why, is part of the
  substrate.
- **The source layer as the wedge.** One source-artifact contract for
  vaults, repos, docs, email, transcripts, and future providers. The
  harder version is sources as triggers, not just recall inputs.
- **Portability as the moat.** File over app. Your context outlives
  every model, every harness, and every company — including this one.

## What Signet is not

This is the product-positioning list. Contribution policy — what gets
merged, how state is stored, what the daemon accepts as input — lives
in `AGENTS.md` and is not repeated here.

- Not a hosted memory API. The data lives where the user can read and
  delete it. Optional cloud services (sync, hosted inference) connect
  to the local daemon; they never replace it.
- Not a harness-specific plugin. The product is the layer underneath
  harnesses, not another one of them.
- Not a vector store. Vectors and graph state are derived projections.
  Artifacts are the source of truth.
- Not a summarizer. The semantic layer is a navigation aid with
  provenance. A summary that cannot lead back to the source it came
  from is a wrong answer waiting to happen.
- Not a training pipeline. Nothing leaves the user's machine without
  an explicit, user-invoked export. There is no shared base model, no
  federated learning, no shadow fine-tuning on user data. If a system
  claims to "learn what to remember" by training on your context, ask
  where those weights go.
- Not a vendor lock-in. Portability across tools, machines, and
  models is the product, not a feature.

This list is a charter, not a law of physics. Strong user demand and
strong technical rationale can change it.

---

*Written by Nicholai and Ant. Revised August 2026 to state the
endgame — measured, user-custodied access to personal data for AI —
alongside the shipped product, which remains local-first memory,
secrets, and portability. Replaces the June 2026 draft, which described
the continuity layer without naming where it leads.*

# Signet

<p align="center">
  <a href="https://opensource.org/licenses/Apache-2.0"><img src="https://img.shields.io/badge/License-Apache%202.0-blue.svg" alt="License: Apache-2.0" /></a>
  <a href="https://signetai.sh/spec"><img src="https://img.shields.io/badge/spec-v0.2.1--draft-blue.svg" alt="Spec Version" /></a>
  <a href="https://github.com/signetai/signetai/stargazers"><img src="https://img.shields.io/github/stars/signetai/signetai.svg" alt="GitHub Stars" /></a>
</p>

<table>
<tr>
<td width="240" valign="top">
  <img src="public/signetposter-01.jpg" alt="Signet — your AI has a memory, you don't own it" width="220" />
</td>
<td valign="top">

**Your agent is an investment. Signet is where its value accumulates.**

Signet is an open protocol for agent identity, knowledge, and trust.
It defines how an agent should persist across sessions, learn from
its operator, and carry its identity between tools. The reference
implementation ships a distillation engine that turns raw conversation
into structured insights, a knowledge graph that maps how those
insights connect, and a portable identity layer that follows your
agent into any harness you use.

Everything runs locally. You own the data. The agent is yours.

</td>
</tr>
</table>

---

Why Signet
===

Your agent starts every session from zero. It doesn't know what you
worked on yesterday. It doesn't know your preferences, your projects,
or the decisions you've already made together. Every session is a
first date.

Signet fixes this. Not with a vector store that regurgitates old
conversations — with a distillation engine that extracts structured
insights from every session, maps them into a knowledge graph, and
assembles the right context for the right moment. Your agent doesn't
just remember. It *understands*.

The same agent follows you across Claude Code, OpenCode, and
OpenClaw. Same personality, same knowledge, same secrets. Switch
tools without starting over.

---

How it works
===

### The distillation layer

At the end of every conversation, Signet reviews the session and
distills it. Not "save the transcript" — *distill*. A local LLM
breaks the conversation into atomic facts, checks them against
what's already known, and decides: file as new, update something
existing, replace something outdated, or skip entirely. Your agent
won't store "prefers dark mode" fourteen times. It recognizes the
insight already exists and moves on.

<p align="center">
  <img src="public/memory-loop-v2.jpg" alt="Signet memory loop — extraction, decision, and retention flow" width="620" />
</p>

### The knowledge graph

Named entities — people, projects, tools, concepts — are extracted
and linked. When you ask about a project, Signet doesn't just find
text that sounds related. It traverses the graph: the project's
architecture, the people involved, the tools it depends on, the
constraints that apply. Context arrives structured, not as a pile of
fragments hoping something useful is in there.

<p align="center">
  <img src="public/constellation.jpg" alt="Signet constellation view — knowledge graph visualization with entity clusters and force-directed layout" width="720" />
</p>

### The index

Every insight is embedded and indexed. Retrieval blends keyword
search, semantic similarity, and graph traversal into a single
ranked result. The constellation view in the dashboard lets you see
your agent's knowledge topology — what's connected, what's isolated,
what's going stale.

### Document ingest

Feed any document into the distillation layer. PDFs, specs, reference
pages, URLs. They're chunked, embedded, and indexed alongside your
agent's insights. Point Signet at a codebase's docs and they become
part of what your agent knows.

### Safety guarantees

- **Raw-first**: content is persisted before any LLM processing begins
- **Pinned insights are sacred**: the distillation layer cannot modify
  them. Only you can.
- **Everything is recoverable**: deletions are soft, with a 30-day
  recovery window and full audit trail

---

Install
===

```bash
bun add -g signetai        # or: npm install -g signetai 
signet setup               # interactive setup wizard
```

The wizard initializes `~/.agents/` (or configure your own directory),
configures your selected harnesses, sets up an embedding provider 
(Native/Ollama/OpenAI), creates the database, and starts the daemon.

### Tell your agent to install it

Paste this to your AI agent:

```
Install and fully configure Signet AI by following this guide exactly: https://signetai.sh/skill.md
```

### Use it

```bash
signet status              # check daemon health
signet dashboard           # open the web UI

signet remember "prefers bun over npm"
signet recall "coding preferences"
```

In connected harnesses, skills work directly:

```text
/remember critical: never commit secrets to git
/recall release process
```

---

Harness support
===

| Harness | Status | Integration |
|---|---|---|
| Claude Code | Supported | Hooks + CLAUDE.md sync |
| OpenCode | Supported | Plugin + AGENTS.md sync |
| OpenClaw | Supported | Runtime adapter + bootstrap |
| Codex | In progress | WIP |
| Gemini CLI | Planned | WIP |

---

What Signet is building
===

Signet is a protocol, not just a product. The reference implementation
is the proof that the protocol works. Here's the full picture:

### Identity

Portable agent identity in plain files at `~/.agents/` by default.
Instructions, personality, user profile, working knowledge — 
all inspectable, version-controlled, and synced across harnesses 
automatically. Your agent's identity is not locked inside any 
vendor's platform.

```text
~/.agents/
  agent.yaml        # manifest + runtime config
  AGENTS.md         # operating instructions
  SOUL.md           # personality + voice
  IDENTITY.md       # structured identity
  USER.md           # operator profile
  MEMORY.md         # synthesized working knowledge
  skills/           # installed capabilities
  .secrets/         # encrypted secret store
```

### Insights, not observations

Other tools store observations — raw text thrown into a vector
database and retrieved by cosine distance. Signet distills
observations into insights: structured facts organized into a
knowledge graph with entities, aspects, attributes, and dependency
edges. The difference is the difference between a pile of sticky
notes and an actual understanding of the domain.

### Trust and security

Secrets are libsodium-encrypted at rest. Your agent can use secrets
without ever reading their values — Signet injects them into
subprocess environments and redacts them from captured output. Auth
supports local-only, token-based, and hybrid modes with role-based
access control.

The distillation layer runs on a local Ollama model by default.
Nothing leaves your machine unless you configure it to.

### The protocol layer

Signet defines how agents should carry identity, how knowledge should
be structured, and how trust should be established. The spec is open.
The implementation is open. The goal is a standard that any tool can
adopt — not a walled garden that locks you in.

---

Architecture
===

```text
CLI (signet)
  setup, knowledge, secrets, skills, hooks, git sync, service mgmt

Daemon (@signet/daemon, localhost:3850)
  |-- HTTP API (90+ endpoints across 18 domains)
  |-- Distillation Layer
  |     extraction -> decision -> graph -> retention
  |-- Document Worker
  |     ingest -> chunk -> embed -> index
  |-- Maintenance Worker
  |     diagnostics -> health scoring -> repair
  |-- Auth Middleware
  |     local / team / hybrid, RBAC, rate limiting
  |-- Analytics
  |     usage, errors, latency, tokens
  |-- File Watcher
        identity sync, git auto-commit

Core (@signet/core)
  types, identity, SQLite, hybrid search, graph traversal

SDK (@signet/sdk)
  typed client, React hooks, Vercel AI SDK middleware

Connectors
  claude-code, opencode, openclaw
```

Packages
---

| Package | Role |
|---|---|
| [`@signet/core`](./packages/core) | Types, identity, SQLite, hybrid + graph search |
| [`@signet/cli`](./packages/cli) | CLI, setup wizard, dashboard |
| [`@signet/daemon`](./packages/daemon) | API server, distillation layer, auth, analytics, diagnostics |
| [`@signet/sdk`](./packages/sdk) | Typed client, React hooks, Vercel AI SDK middleware |
| [`@signet/connector-claude-code`](./packages/connector-claude-code) | Claude Code integration |
| [`@signet/connector-opencode`](./packages/connector-opencode) | OpenCode integration |
| [`@signet/connector-openclaw`](./packages/connector-openclaw) | OpenClaw integration |
| [`@signetai/adapter-openclaw`](./packages/adapters/openclaw) | OpenClaw runtime plugin |
| [`signetai`](./packages/signetai) | Meta-package (`signet` binary) |

---

Documentation
===

**Usage**
- [Quickstart](./docs/QUICKSTART.md)
- [CLI Reference](./docs/CLI.md)
- [Configuration](./docs/CONFIGURATION.md)
- [Hooks](./docs/HOOKS.md)
- [Harnesses](./docs/HARNESSES.md)
- [Connectors](./docs/CONNECTORS.md)
- [Secrets](./docs/SECRETS.md)
- [Skills](./docs/SKILLS.md)
- [Auth](./docs/AUTH.md)
- [Dashboard](./docs/DASHBOARD.md)
- [SDK](./docs/SDK.md)
- [API Reference](./docs/API.md)

**Architecture and Design**
- [Architecture](./docs/ARCHITECTURE.md)
- [Knowledge Architecture](./docs/KNOWLEDGE-ARCHITECTURE.md)
- [Knowledge Graph](./docs/KNOWLEDGE-GRAPH.md)
- [Desire Paths](./docs/DESIRE-PATHS.md) — learned traversal through the knowledge graph
- [Lossless Context Patterns](./docs/LCM-PATTERNS.md) — deterministic guarantees for the distillation layer
- [ACP Integration](./docs/ACP-INTEGRATION.md) — Agent Client Protocol integration
- [Spec Index](./docs/specs/INDEX.md) — build sequence and integration contracts

Research
---

| Paper / Project | Relevance |
|---|---|
| [Lossless Context Management](https://papers.voltropy.com/LCM) (Voltropy, 2026) | Hierarchical summarization, guaranteed convergence, zero-cost continuity. Patterns adapted in [LCM-PATTERNS.md](./docs/LCM-PATTERNS.md). |
| [Recursive Language Models](https://arxiv.org/abs/2512.24601) (Zhang et al., 2026) | Active context management. LCM builds on and departs from RLM's approach. |
| [acpx](https://github.com/openclaw/acpx) (OpenClaw) | Agent Client Protocol. Structured agent coordination, session persistence. |
| [lossless-claw](https://github.com/Martian-Engineering/lossless-claw) (Martian Engineering) | LCM reference implementation as an OpenClaw plugin. |
| [openclaw](https://github.com/openclaw/openclaw) (OpenClaw) | Agent runtime reference. |
| [arscontexta](https://github.com/agenticnotetaking/arscontexta) | Agentic notetaking patterns. |
| [ACAN](https://github.com/HongChuanYang/Training-by-LLM-Enhanced-Memory-Retrieval-for-Generative-Agents-via-ACAN) (Hong et al.) | LLM-enhanced memory retrieval for generative agents. |

---

Development
===

```bash
git clone https://github.com/signetai/signetai.git
cd signetai

bun install
bun run build
bun test
bun run lint
```

```bash
cd packages/cli && bun run dev          # CLI dev
cd packages/cli/dashboard && bun run dev # Dashboard dev
cd packages/daemon && bun run dev        # Daemon dev (watch mode)
```

Requirements: Node.js 18+, Bun, Ollama (recommended) or OpenAI API
key. macOS or Linux.

Contributing
===

See [`CONTRIBUTING.md`](./CONTRIBUTING.md). Build on existing patterns.
Open an issue before contributing significant features.

License
===

Apache-2.0.

---

[signetai.sh](https://signetai.sh) --
[docs](https://signetai.sh/docs) --
[spec](https://signetai.sh/spec) --
[issues](https://github.com/signetai/signetai/issues)

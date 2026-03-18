---
title: "ACP Integration"
description: "Integrating the Agent Client Protocol into Signet's agent coordination layer."
order: 5
section: "Architecture"
---

ACP Integration
===============

*Why adopt a standard instead of building your own.*

> *Signet handles the who and the why. ACP handles the how.
> Neither is complete without the other.*

This document describes how Signet integrates with acpx and the Agent
Client Protocol (ACP) to gain structured agent coordination, session
persistence, and a path toward the multi-agent vision described in
`VISION.md`.

References:
- acpx: `references/acpx/`
- ACP protocol: JSON-RPC 2.0 over NDJSON stdio
- Research notes: `docs/research/technical/RESEARCH-LCM-ACP.md`

---


Why ACP, Not Our Own
--------------------

ACP is becoming the standard protocol for agent-to-agent communication
in the coding assistant ecosystem. acpx already has adapters for Claude
Code, Codex, Gemini, OpenClaw, OpenCode, and Pi. The protocol is
bi-directional JSON-RPC 2.0 with structured session lifecycle,
permission negotiation, and capability discovery.

Building our own would mean:
- Writing adapters for every harness we support (duplicating acpx's work)
- Defining a session protocol (already defined by ACP)
- Building queue management and crash recovery (already built in acpx)
- Maintaining compatibility as harnesses evolve (acpx tracks this)

Adopting ACP means:
- Fewer migrations as the ecosystem standardizes
- Interoperability with any tool that speaks ACP
- Focus on what Signet uniquely provides (identity, memory, learning)
  instead of plumbing

The strategic bet: ACP or something like it will become the standard.
If we adapt to its patterns now, we avoid a painful migration later.
If it doesn't become the standard, the patterns are still sound and
the integration is thin enough to swap out.


---


What ACP Provides That Signet Lacks
------------------------------------

### 1. Outbound Agent Communication

Signet's daemon is entirely inbound. Agents call us through hooks
and MCP tools. We never initiate contact. We cannot ask an agent a
question, delegate a subtask, or request a summary.

ACP gives Signet the ability to call out. The daemon can spawn an
acpx session, submit a prompt, and receive structured results. This
unlocks agentic autonomy in the pipeline -- the memory system could
use an agent for synthesis decisions rather than relying purely on
local Ollama.

### 2. Session Persistence Across Invocations

The scheduler currently fires one-shot prompts via `Bun.spawn` and
discards the session. There is no conversation history, no crash
recovery, no ability to resume where a task left off.

acpx sessions persist in `~/.acpx/sessions/` as append-only NDJSON
streams. A scheduled task can pick up exactly where it left off. If
the agent crashes, acpx detects the stale PID, attempts
`session/load` on a fresh process, and falls back to `session/new`.

### 3. Structured Output

The scheduler captures raw stdout/stderr as strings. Parsing agent
output is fragile -- tool calls, thinking chunks, and response text
are interleaved with no structure.

acpx's `--format json` mode produces NDJSON events with stable
envelopes: `eventVersion`, `sessionId`, `requestId`, `seq`, `stream`,
`type`. The pipeline would know exactly which chunks are tool calls,
which are thinking, and which are final response text. Memory
extraction becomes dramatically more reliable.

### 4. Queue-Based Concurrency Control

Multiple processes targeting the same agent session are serialized
through a Unix domain socket IPC protocol. The "queue owner" pattern
prevents concurrent prompt submission from corrupting session state.
Signet has no equivalent -- if two scheduled tasks target the same
agent, they stomp each other.

### 5. Cooperative Cancellation

`acpx cancel` sends a `session/cancel` message through the ACP
protocol. The agent receives it and can wind down gracefully.
Signet's scheduler has no cancel mechanism beyond killing the process.


---


What Signet Provides That ACP Lacks
-------------------------------------

### 1. Memory and Identity

acpx has no concept of who the agent is or what it knows. It manages
sessions, not cognition. Signet provides the identity files
(AGENTS.md, SOUL.md, IDENTITY.md, USER.md), the memory pipeline
(extraction, knowledge graph, hybrid search), and the predictive
scorer. An acpx session without Signet is amnesiac.

### 2. Cross-Session Knowledge

acpx sessions are isolated. What happens in one session does not
inform another. Signet's knowledge graph and memory pipeline ensure
that knowledge extracted from any session is available in every
future session, regardless of which agent or harness was used.

### 3. Learning

acpx is deterministic infrastructure. It routes prompts and manages
sessions. It does not learn which contexts are useful, which paths
produce good results, or how the user's needs shift over time. Signet's
behavioral feedback loop, aspect decay, and (future) desire paths
scoring are the learning layer that sits on top.

### 4. The Dashboard

Full observability into memory state, entity health, session history,
pipeline status. acpx has CLI-only status output. Signet provides
the window into what's happening.


---


How They Compose
----------------

The clean separation:

```
┌─────────────────────────────────────────────┐
│              Signet Daemon                   │
│  Identity | Memory | Knowledge | Learning   │
│                                             │
│  "Who is this agent? What does it know?     │
│   What should it remember? What patterns    │
│   are emerging?"                            │
└──────────────────┬──────────────────────────┘
                   │ enriches / extracts
┌──────────────────▼──────────────────────────┐
│              ACP (via acpx)                  │
│  Sessions | Protocol | Queue | Recovery     │
│                                             │
│  "How do I talk to this agent? How do I     │
│   manage the conversation? How do I         │
│   recover from failures?"                   │
└──────────────────┬──────────────────────────┘
                   │ spawns / controls
┌──────────────────▼──────────────────────────┐
│          Coding Agent Harnesses              │
│  Claude Code | Codex | Gemini | OpenClaw    │
│                                             │
│  "Execute this task. Use these tools.       │
│   Produce this output."                     │
└─────────────────────────────────────────────┘
```

Signet sits above ACP. ACP sits above the harnesses. Each layer
handles its own concerns. Signet never needs to know how to spawn
a Claude Code process -- acpx handles that. acpx never needs to
know what memories to inject -- Signet handles that.


---


Phase 1: Scheduler Uses acpx
-----------------------------

*Scope: small. Value: high. Risk: low.*

Replace raw `Bun.spawn` in the scheduler with acpx session management.

### What Changes

`packages/daemon/src/scheduler/spawn.ts` gains an `acpx` spawn mode.
When a task's harness is configured for acpx (or a global flag
enables it), the scheduler calls acpx instead of the harness CLI
directly.

### Command Mapping

Current:
```
claude --dangerously-skip-permissions -p "task prompt"
codex exec --skip-git-repo-check --json "task prompt"
opencode run --format json "task prompt"
```

With acpx:
```
acpx claude -s task-{taskId} --format json "task prompt"
acpx codex -s task-{taskId} --format json "task prompt"
acpx opencode -s task-{taskId} --format json "task prompt"
```

### Session Affinity

Each task gets a stable session name: `task-{taskId}`. Subsequent
runs of the same task reuse the session, giving the agent continuity
across periodic executions. A daily code review task remembers
yesterday's findings.

### Structured Output Parsing

acpx's JSON output mode produces NDJSON events. The scheduler can
parse these into typed records:
- `thinking` events: agent reasoning (useful for debugging, not stored)
- `tool_call` events: what the agent did (useful for audit trails)
- `text` events: final response (what gets stored in `task_runs.stdout`)
- `error` events: failures with structured context

This replaces raw stdout string capture with typed event processing.

### Crash Recovery

If an agent process dies mid-task:
1. acpx detects the stale PID on next invocation
2. Attempts `session/load` to resume the conversation
3. Falls back to `session/new` if the session is unrecoverable
4. The scheduler retries the prompt in the recovered session

Current behavior: the scheduler marks the task as failed and moves on.
With acpx: the scheduler gets automatic recovery for free.

### Implementation

- Add `acpx` to PATH during daemon startup (or use `npx acpx`)
- Add `spawnMode: 'raw' | 'acpx'` to task configuration
- Modify `buildCommand()` in `spawn.ts` to generate acpx commands
- Add NDJSON event parser for structured output
- Store `acpxRecordId` alongside task run in `task_runs` table
  (enables future "view conversation history" feature)
- `SIGNET_NO_HOOKS=1` still injected to prevent hook loops
- Permission mode: `--approve-all` for autonomous tasks (equivalent
  to current `--dangerously-skip-permissions`)

### What This Unlocks

- Conversation continuity across scheduled task runs
- Crash recovery without manual handling
- Structured output parsing for better memory extraction
- Cancel support (`acpx cancel -s task-{taskId}`)
- Foundation for Phase 2


---


Phase 2: Signet as ACP Memory Proxy
------------------------------------

*Scope: medium. Value: high. Risk: medium.*

Signet wraps itself as an ACP adapter that transparently enriches
any agent session with memory.

### The Concept

An ACP adapter is any process that speaks ACP stdio protocol. Signet
can implement an adapter that:

1. Receives `initialize` -> negotiates capabilities
2. Receives `newSession` -> calls `/api/hooks/session-start`, injects
   memories into the session context
3. Receives `prompt` -> prepends memory context, forwards to the
   underlying agent (another ACP endpoint), captures response, calls
   `/api/hooks/session-end` for extraction
4. Receives `loadSession` -> restores Signet session context

The adapter is invoked as:
```
signet acp --agent codex
```

And registered in acpx config:
```json
{
  "agents": {
    "signet-codex": "signet acp --agent codex",
    "signet-claude": "signet acp --agent claude"
  }
}
```

Then: `acpx signet-codex "fix the tests"` gives a memory-augmented
agent session with full acpx session management. Any acpx user gets
Signet memory transparently.

### Memory Injection Strategy

The adapter intercepts the first prompt in a session and prepends
Signet's context assembly (identity files, recalled memories,
constraints, entity traversal results). Subsequent prompts in the
same session get per-prompt context if configured.

For agents with native MCP support, the adapter can also pass
Signet's MCP endpoint in the `mcpServers` array of `newSession`,
giving the agent direct access to memory tools without the hook
system.

### Session Correlation

The adapter maps the `acpxSessionId` to a Signet session key. This
enables:
- Memory extraction correlated with specific acpx sessions
- Dashboard view of "which agent sessions generated which memories"
- The `acpxRecordId` becomes a foreign key in Signet's session
  checkpoint tables

### Implementation

- New CLI command: `signet acp --agent <name>`
- New module: `packages/daemon/src/acp-bridge/`
- Implements ACP server-side protocol (using `@agentclientprotocol/sdk`
  `AgentSideConnection`)
- Spawns the underlying agent as a child ACP client
- Proxies all ACP messages, intercepting session lifecycle events
  for memory injection/extraction
- Configuration: `agent.yaml` gains an `acp` section for adapter
  settings

### What This Unlocks

- Memory-augmented sessions for any ACP-compatible agent, regardless
  of whether the agent supports Signet hooks natively
- The hook system becomes a compatibility layer rather than the
  primary integration path
- Any tool that speaks acpx gets Signet memory for free
- Foundation for Phase 3


---


Phase 3: Cross-Agent Coordination
----------------------------------

*Scope: large. Value: transformative. Risk: high.*

Signet becomes the coordination layer where agents discover each
other, share context, and delegate work through ACP sessions managed
by the daemon.

### The Vision

Today's Signet manages one agent's memory. Tomorrow's Signet manages
a fleet. The daemon knows which agents exist (from `agent.yaml`),
what each one knows (from its memory), and what each one is good at
(from skill entities and usage patterns).

When Agent A needs something done, it doesn't spawn a raw process.
It asks Signet: "I need a code review of these changes." Signet:
1. Identifies which agent is best suited (skill matching)
2. Injects relevant context from its memory into the request
3. Opens an ACP session with the target agent via acpx
4. Routes the task with the enriched prompt
5. Captures the result and extracts memories for both agents
6. Returns the result to Agent A

### Relationship to Existing Cross-Agent Messaging

Signet's MCP tools (`agent_message_send`, `agent_message_inbox`)
provide peer-to-peer messaging between Signet-aware agents. This is
asynchronous, fire-and-forget communication -- passing notes.

ACP provides synchronous, session-based communication -- structured
conversations with results. The two patterns are complementary:

- **MCP messaging**: "Hey, when you get a chance, look at this."
  Async. No session. No structured result.
- **ACP sessions**: "I need you to review this PR and give me
  structured feedback now." Sync. Session with history. Typed output.

Phase 3 unifies these: an agent can choose between async messaging
(MCP) and sync delegation (ACP) depending on the task. Signet
coordinates both.

### The Scope-Reduction Invariant

Borrowed from LCM's sub-agent architecture: when Agent A delegates
to Agent B, the request must declare `delegated_scope` (what B is
responsible for) and `kept_work` (what A retains). If A cannot
articulate what it's keeping -- i.e., it would delegate its entire
responsibility -- the delegation is rejected.

This structurally prevents infinite delegation chains. Each level
of delegation must represent a strict reduction in scope.

### Agent Discovery

The daemon exposes `/api/agents` (currently implicit via
`agent.yaml`). For Phase 3, this becomes an active registry:

```json
{
  "agents": [
    {
      "id": "mr-claude",
      "capabilities": ["code-review", "architecture", "memory-management"],
      "status": "available",
      "currentSession": null
    },
    {
      "id": "review-bot",
      "capabilities": ["code-review", "testing"],
      "status": "busy",
      "currentSession": "task-42"
    }
  ]
}
```

Capabilities are derived from skill entities and usage patterns.
Status comes from acpx session state. Discovery is local (same
machine), not networked (that's a different problem for a different
day).

### Implementation (High Level)

This is a multi-month effort. The implementation sequence:

1. Agent registry with capability matching (`/api/agents/discover`)
2. Delegation API (`/api/agents/delegate`) that:
   - Validates scope-reduction invariant
   - Opens acpx session with target agent
   - Injects context from Signet's memory
   - Returns structured result
3. Dashboard: agent fleet view showing status, active sessions,
   delegation chains
4. Predictor integration: learn which agents succeed at which tasks
   (delegation scoring, analogous to path scoring)

### What This Unlocks

The multi-agent vision from VISION.md. Agents that can hire other
agents. Specialization. Division of labor. The daemon as nervous
system, not just memory bank.


---


Phase 4: Signet as ACP-Native Platform (Future)
-------------------------------------------------

*Scope: architectural shift. Timeline: 2026 H2 or later.*

The hook system becomes a compatibility shim. The primary integration
path is ACP + MCP. Signet's identity model (AGENTS.md, SOUL.md) is
injected at the ACP protocol level, not via harness-specific file
generation.

Connectors evolve from "install hooks into harness config" to "thin
ACP adapters that bridge harness-native protocols to ACP." The
connector's job simplifies: it just needs to translate the harness
into an ACP speaker. Signet handles everything else.

This is the endgame, but it depends on ACP adoption across the
ecosystem. We build toward it incrementally -- each phase brings
value on its own, and each phase makes the next one easier.


---


Migration Path
--------------

The integration is additive at every phase. Nothing is removed until
it is fully superseded.

```
Phase 1: scheduler gains acpx mode (raw spawn still works)
Phase 2: ACP adapter added (hooks still work)
Phase 3: delegation API added (MCP messaging still works)
Phase 4: hooks become compatibility shim (ACP is primary)
```

At no point does an existing integration break. Users who don't want
acpx continue using hooks. Users who adopt acpx get session
persistence and memory enrichment for free.


---


Dependencies
------------

- `acpx` npm package (or vendored binary)
- `@agentclientprotocol/sdk` for Phase 2+ (ACP server-side protocol)
- No changes to existing harness connectors for Phase 1
- Phase 2 requires new `packages/daemon/src/acp-bridge/` module
- Phase 3 requires multi-agent support from the existing spec

---

*This document describes the integration vision and phased plan.
Phase 1 is ready for implementation. Phases 2-4 are directional
and will be refined as ACP matures and Signet's multi-agent
architecture solidifies.*

---

*Written by Nicholai and Mr. Claude. March 8, 2026.*

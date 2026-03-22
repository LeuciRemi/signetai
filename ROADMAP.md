Roadmap
===

This is the public roadmap for Signet, updated manually as priorities
shift. It captures what we're actively building, what's committed next,
and what we're still thinking through. For a detailed history of what
has shipped, see CHANGELOG.md.

Status markers: `[done]` shipped, `[wip]` in progress, `[next]` planned,
`[idea]` exploring.


Current Focus (0.71.x)
---

- [wip] Desire Paths Phase 4 — path-level feedback propagation and
  traversal path scoring; evolves the predictor from ranking individual
  memories to ranking traversal paths through the knowledge graph
- [wip] Procedural memory P2–P5 — usage tracking, implicit relation
  computation, retrieval and suggestion endpoints, dashboard visualization
- [wip] Multi-agent support — multiple agent identities per daemon,
  shared skills pool, fully scoped memory isolation via agent_id
- [wip] Signet Runtime — standalone runtime channel independent of
  harness-specific connectors; built-in tool registry, pre-generation
  research phase


Planned
---

- [next] Desire Paths Phase 5 — explorer bees (autonomous graph
  exploration), cross-entity boundary traversal, discovered principles
  as first-class entity type, entity health dashboard
- [next] Federated predictor training — community base model ships with
  new installs, local fine-tuning on user interaction patterns; cold
  start eliminated
- [next] Wallet auth (EIP-8004) — blockchain-based agent identity
  verification for open-ended agent economies
- [next] Encrypted sync — end-to-end encrypted agent state
  synchronization using existing wallet keypairs
- [next] Agent branching — version-control-like identity branching
  and merging (one agent across multiple concurrent sessions converges
  back to a single history)
- [next] Gemini CLI connector — platform adapter


Exploring
---

- [idea] Agent marketplace — discover, hire, and compose other Signet
  agents; enabled by standardized identity and EIP-8004
- [idea] Collaborative memory — shared memory pools across agent teams
  with scoped access control
- [idea] Mobile companion — lightweight agent presence on iOS/Android
- [idea] Daemon Rust rewrite — systems language migration; shadow proxy
  runs both in parallel and logs divergences


Recently Shipped
---

- [done] 0.71.0 — Desire Paths Phase 3: traversal-primary retrieval
  (DP-6), constructed memories with path provenance (DP-7), prospective
  indexing at write time (DP-6.1), cosine re-scoring of traversal
  results (DP-6.2), scoped vector search with 2x over-fetch (DP-6.3),
  predictor bug fixes (DP-8)
- [done] 0.70.x — Desire Paths Phase 1–2: significance gate (DP-1),
  edge confidence + reason on entity dependencies (DP-2), bounded
  traversal parameters (DP-3), MCP tool registration and blast radius
  endpoint (DP-4), Louvain community detection (DP-5)
- [done] 0.69.x — Predictive memory scorer all four sprints complete
  and enabled; Rust crate with autograd, ListNet loss, training
  pipeline, daemon integration, observability dashboard
- [done] 0.68.x — Knowledge Architecture KA-1 through KA-6 complete:
  entity/aspect/attribute schema, graph traversal, predictor coupling,
  session continuity integration, entity pinning and behavioral feedback
  loop (FTS overlap → aspect weight, per-entity predictor win rates)
- [done] 0.67.x — Session continuity: session_checkpoints table,
  checkpoint digests, recovery injection, 2000-char recovery budget
- [done] 0.66.x — ClawHub marketplace integration; skills.sh + ClawHub
  aggregated catalog in dashboard
- [done] 0.65.x — Codex connector with transcript normalization and
  timeout reporting
- [done] 0.64.x — OpenClaw runtime plugin; NemoClaw compatibility
- [done] 0.63.x — Auth module: token-based middleware, policy rules,
  rate limiting; scheduler with cron worker and SSE output streaming
- [done] 0.62.x — Native Rust vector ops with SIMD acceleration
  (`@signet/native` napi-rs crate); server-side UMAP with pre-computed
  projections and cache
- [done] 0.61.x — Memory Pipeline V2: LLM-based extraction, knowledge
  graph, retention decay, document ingest, session summary worker

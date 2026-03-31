---
title: "Overview Usage Analytics"
id: overview-usage-analytics
status: approved
informed_by:
  - docs/research/technical/RESEARCH-OVERVIEW-USAGE-ANALYTICS.md
  - docs/specs/approved/mcp-cli-bridge-and-usage-analytics.md
  - docs/specs/approved/procedural-memory-plan.md
section: "CLI + Dashboard"
depends_on:
  - "mcp-cli-bridge-and-usage-analytics"
  - "procedural-memory-plan"
success_criteria:
  - "The home overview card ranks MCP servers from real invocation analytics instead of marketplace popularity"
  - "The home overview card ranks skills from real invocation analytics instead of catalog popularity"
  - "Usage ranking and presentation metadata remain decoupled so missing catalog metadata does not hide historical usage"
  - "Skill usage tracking updates procedural-memory usage fields and powers a dashboard analytics surface without task-ownership scope expansion"
scope_boundary: "Overview-card truthfulness and shared usage analytics only. Does not redesign task ownership, migration strategy, or predictive-scorer feature export."
---

# Overview Usage Analytics

Spec metadata:
- ID: `overview-usage-analytics`
- Status: `approved`
- Hard depends on: `mcp-cli-bridge-and-usage-analytics`, `procedural-memory-plan`
- Registry: `docs/specs/INDEX.md`

## Contract

### Usage ledger contract

1. MCP server usage remains sourced from `mcp_invocations`.
2. Skill usage gains a matching invocation ledger in SQLite.
3. Skill usage writes must also update `skill_meta.use_count` and
   `skill_meta.last_used_at`.
4. The implementation must avoid one-off home-card counters or duplicate
   tracking paths.

### Analytics read contract

1. MCP analytics stay queryable through the existing summary route.
2. Skill analytics expose a parallel summary route with the same core
   shape: total calls, success rate, top items, and latency percentiles.
3. Both routes support time-window filtering so the overview can render a
   bounded "most used" view.

### Overview rendering contract

1. The home overview card must render from analytics ranking, not catalog
   order.
2. The card must surface both top skills and top MCP servers in one
   coherent overview module.
3. Presentation metadata is enriched from installed/catalog sources when
   available, but historical usage rows must still render when metadata is
   missing.

## Validation requirements

1. Migration tests for the skill invocation ledger.
2. Regression coverage that task-driven skill usage records invocation
   rows and updates procedural-memory usage fields.
3. Analytics query tests for skill ranking, latency, and time filtering.
4. Dashboard validation that the overview card reflects analytics-driven
   ranking instead of catalog popularity.

---
title: "Overview Usage Analytics Research"
question: "How should the dashboard overview surface real most-used MCP servers and skills without duplicating analytics plumbing or relying on catalog popularity?"
date: "2026-03-30"
status: "complete"
---

# Overview usage analytics research

## What this research answers

This note captures the concrete repo reality behind the dashboard
overview card so the follow-on approved spec can point to a durable
source instead of chat context.

## Findings

1. The home overview card is not usage-backed today. It renders
   marketplace catalog slices and labels them "MOST USED SKILLS &
   SERVERS", which is materially false.
2. MCP usage already has a workable backend shape:
   - `mcp_invocations` table
   - daemon-side write path
   - `/api/mcp/analytics` summary route
3. Skill usage does not have a matching invocation ledger yet in this
   branch, even though procedural-memory docs already describe skill
   usage as a first-class signal.
4. The cleanest implementation path is symmetry, not a bespoke home-card
   endpoint:
   - one invocation-table pattern
   - one summary-analytics route pattern
   - one overview-card rendering pattern
5. Metadata for presentation and analytics for ranking should stay
   separate. Usage ranking comes from invocation tables, while names,
   descriptions, and avatars can be enriched from installed and catalog
   metadata with graceful fallbacks.

## Guardrail direction

- Do not rank overview items from catalog popularity.
- Reuse existing MCP analytics contracts instead of adding home-only
  counters.
- Add skill invocation tracking as the mirror image of MCP invocation
  tracking.
- Keep the overview surface honest when metadata is missing by showing
  historical usage rows with fallback labels instead of dropping them.

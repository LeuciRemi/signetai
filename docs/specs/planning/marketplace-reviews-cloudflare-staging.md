---
title: "Marketplace Reviews Cloudflare Staging Plan"
description: "Staging strategy for Signet Reviews scaffolding on Cloudflare Pages."
status: "planning"
informed_by: []
success_criteria: []
scope_boundary: ""
---

# Marketplace Reviews Cloudflare Staging Plan

## Context

The Marketplace UI overhaul introduces `Signet Reviews` scaffolding for Skills and MCP servers.
We are intentionally not completing the production review backend in this PR.
This document defines how reviews are staged now and how we complete Cloudflare-backed persistence next.

## Current Stage (in this branch)

- UI scaffolding exists in Marketplace right rail (`Signet Reviews` and `Sync`).
- API surface exists in daemon for reviews CRUD + sync config.
- Temporary local persistence is file-based and only intended for staging and UX validation.
- Display-name authorship is used for PR1 (no signed identity yet).

## Target Cloudflare Architecture (next stage)

- Runtime: Cloudflare Worker service dedicated to Marketplace Reviews API.
- Database: Cloudflare D1 (`signet_marketplace_reviews`) for review records and sync metadata.
- Optional cache: Cloudflare KV for hot aggregates and rate-limit counters.
- Daemon role: sync client and local UX adapter, not source of truth.

## D1 Schema (proposed)

```sql
CREATE TABLE IF NOT EXISTS reviews (
  id TEXT PRIMARY KEY,
  target_type TEXT NOT NULL CHECK (target_type IN ('skill', 'mcp')),
  target_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'signet',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_reviews_target
  ON reviews(target_type, target_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS review_sync_events (
  id TEXT PRIMARY KEY,
  direction TEXT NOT NULL CHECK (direction IN ('push', 'pull')),
  status TEXT NOT NULL CHECK (status IN ('ok', 'error')),
  error TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS review_aggregates (
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  review_count INTEGER NOT NULL DEFAULT 0,
  avg_rating REAL NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (target_type, target_id)
);
```

## API Contract (Cloudflare Worker)

- `GET /reviews?type=&id=&limit=&offset=`
- `POST /reviews`
- `PATCH /reviews/:id`
- `DELETE /reviews/:id`
- `GET /reviews/summary?type=&id=`

Daemon sync endpoint target (for PR1-compatible shape):

- `POST /ingest/signet-reviews`
  - accepts batched review payload currently sent by daemon
  - returns `{ success: true, accepted: number }`

## Rollout Stages

1. **PR1 (current):** UI + daemon review scaffold + temporary local persistence.
2. **Stage 2:** Deploy Worker + D1 schema + ingest endpoint (no UI contract changes).
3. **Stage 3:** Switch daemon sync default to Cloudflare endpoint; local mode remains fallback.
4. **Stage 4:** Add moderation and trust/rate controls (display-name abuse hardening).

## Migration Notes

- Keep daemon response shapes stable so UI does not change.
- Add backend metadata in config response later:
  - `backend: "local-file" | "cloudflare-d1"`
  - `mode: "staging" | "production"`
- Backfill path from local file records to D1 should run once per workstation if needed.

## Security and Abuse Controls (Stage 2+)

- Worker-level rate limiting by IP and target_id.
- Payload validation and title/body length limits.
- Soft delete only; preserve audit trail in `review_sync_events`.
- Optional signed daemon token header for ingest endpoint.

## QA Checklist Before Cloudflare Cutover

- CRUD parity between local mode and Cloudflare mode.
- Summary math parity (`count`, `avg_rating`) across endpoints.
- Sync retries and duplicate idempotency behavior verified.
- Error paths in UI remain non-blocking and actionable.

## PR Review Summary Block (for Nicholai)

Use this in the PR description under a dedicated section:

```md
### Reviews Staging (Cloudflare Plan)

This PR intentionally ships **Signet Reviews scaffolding only** (UI + daemon contracts + staged local persistence) and does **not** finalize production review infrastructure.

- Current stage: review UX and API contracts are in place for Skills and MCP servers.
- Temporary backend: local file persistence for development/staging validation.
- Next stage: migrate source-of-truth storage to **Cloudflare Worker + D1** with unchanged UI contracts.
- Follow-up scope: Worker endpoints, D1 schema, daemon sync cutover, and moderation/rate-limit hardening.

This keeps PR1 focused on Marketplace UX while preserving a low-risk path to Cloudflare-backed reviews.
```

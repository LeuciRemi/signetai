---
title: "CI Contract Invariants Lane"
id: ci-contract-invariants-lane
status: planning
informed_by: []
section: "DevEx"
depends_on:
  - "knowledge-architecture-schema"
success_criteria:
  - "A fast mandatory CI lane validates core invariants and spec/dependency sync on every PR"
  - "Lockfile/install invariants fail fast when package manifests drift from bun.lock"
scope_boundary: "A single GitHub Actions job and supporting check scripts. No changes to application code or database schema."
draft_quality: "auto-generated, needs user validation before implementation"
---

# CI Contract Invariants Lane

## Problem

Spec/dependency drift, missing agent_id scoping on new tables, and
duplicated constants are recurring PR failure modes (see CLAUDE.md
recurring failures #1, #4, #5). These are caught late in review,
wasting reviewer cycles. A fast automated lane would catch them
before human review begins.

## Goals

1. Block PR merge when spec-deps-check fails or INDEX/dependencies
   diverge.
2. Enforce agent_id column presence on all new user-data tables.
3. Detect duplicated constant maps across packages.
4. Catch bun.lock drift before build/test lanes start.
5. Complete in under 60 seconds (no build or test required).

## Non-goals

- Replacing human review for semantic correctness.
- Validating runtime behavior or API contracts (see api-contract-snapshots).

## Proposed approach

**Single CI job** (`invariants` lane) runs on every PR, before build/test.
It executes a sequence of lightweight checks, each exiting non-zero
on failure:

1. **Spec sync** (`bun scripts/spec-deps-check.ts`): Already exists.
   Validates status/directory consistency in dependencies.yaml.
2. **Lockfile integrity** (`bun install --frozen-lockfile`): Fails fast when
   `package.json` changes are not reflected in `bun.lock`.
3. **INDEX consistency** (`scripts/ci-index-check.ts`): New script.
   Parses INDEX.md registry table rows, cross-references with
   dependencies.yaml entries. Flags missing IDs, status mismatches,
   or orphaned entries.
4. **Agent scoping** (`scripts/ci-agent-scope.ts`): New script. Scans
   migration files for CREATE TABLE statements. Any table containing
   user-scoped data columns (content, memory, session) must include
   an `agent_id` column. Allowlist for shared tables (migrations,
   config).
5. **Constant dedup** (`scripts/ci-no-dupes.ts`): New script. Scans
   for known patterns (exported const maps, enum-like objects) that
   appear in more than one package. Reports duplicates with file
   locations.

**Merge gating**: The invariants job is a required status check on
the main branch protection rule.

## Phases

### Phase 1 -- Core checks

- Wire spec-deps-check into a dedicated CI job.
- Implement INDEX consistency and agent scoping checks.
- Add as required status check on main.

### Phase 2 -- Constant dedup and refinement

- Implement constant dedup scanner.
- Add allowlist mechanism for intentional duplications.
- Tune false-positive rate based on first 2 weeks of results.

## Validation criteria

- PR adding a new table without agent_id fails the invariants lane.
- PR modifying dependencies.yaml without matching INDEX update fails.
- PR updating package versions without lockfile refresh fails.
- Lane completes in under 60 seconds on a typical PR.

## Open decisions

1. Should the agent scoping check use a heuristic (column name
   patterns) or an explicit annotation in migration comments?

---
title: "Sprint Brief: Procedural Memory P1"
---

# Sprint Brief: Procedural Memory P1

Schema + Enrichment + Node Creation

---

## What You're Building

Skills become first-class nodes in the knowledge graph. When a skill is
installed, it gets an entity, embeddings, and metadata so the agent can
discover it through memory retrieval — not just filesystem search.

## Required Reading

1. `docs/specs/INDEX.md` — **read the Cross-Cutting Invariants section
   first.** These override anything in the individual spec.
2. `docs/specs/approved/procedural-memory-plan.md` — Phase P1 (section 10)
3. `docs/KNOWLEDGE-ARCHITECTURE.md` — conceptual north star for how
   entities, aspects, and attributes work

## Cross-Cutting Rules (from INDEX)

- **agent_id on every new table.** `skill_meta` must have an `agent_id`
  column. Skills are scoped per-agent in the graph even though the
  filesystem pool is shared. Each agent gets its own skill entity with
  its own usage stats, decay, and edges.
- **Entity type taxonomy is canonical.** Skills use
  `entity_type = 'skill'`. Do not invent new types.
- **Importance is structural.** The `importanceOnInstall` default (0.7)
  is a cold-start value. Once KA tables exist, importance will be
  computed from structural density. Design `skill_meta` to support both.

## Deliverables

### 1. Migration: `skill_meta` table

New migration file in `packages/core/src/migrations/`. Check
`migrations/index.ts` for the next available number.

```sql
CREATE TABLE skill_meta (
  entity_id     TEXT PRIMARY KEY REFERENCES entities(id),
  agent_id      TEXT NOT NULL DEFAULT 'default',
  version       TEXT,
  author        TEXT,
  license       TEXT,
  source        TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'utility',
  triggers      TEXT,
  tags          TEXT,
  permissions   TEXT,
  enriched      INTEGER DEFAULT 0,
  installed_at  TEXT NOT NULL,
  last_used_at  TEXT,
  use_count     INTEGER DEFAULT 0,
  decay_rate    REAL DEFAULT 0.99,
  fs_path       TEXT NOT NULL,
  uninstalled_at TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_skill_meta_agent ON skill_meta(agent_id);
CREATE INDEX idx_skill_meta_source ON skill_meta(source);
```

### 2. Frontmatter enrichment

When a skill is installed and its frontmatter is thin (description
<30 chars or no `triggers` field), run an LLM pass to generate:
- Rich description (1-2 sentences, mechanism + use-case)
- `triggers` list (3-8 discovery phrases)
- `tags` for domain grouping

Use the existing `LlmProvider` from
`packages/daemon/src/pipeline/provider.ts`. Same model config as the
extraction worker. New prompt function alongside
`extractFactsAndEntities()`.

**Critical:** Use YAML round-trip parse/serialize for frontmatter
rewrites. Not regex. Preserve existing fields and comments.

### 3. Skill entity creation

On install:
1. Parse SKILL.md frontmatter
2. Enrich if needed (step 2 above)
3. Create entity row: `entity_type = 'skill'`, `id = 'skill:{name}'`
4. Create `skill_meta` row with installation metadata
5. Generate embedding from enriched frontmatter only:
   `name + description + triggers`. NOT the body.
6. Store embedding via existing `embeddings` pipeline with
   `source_type = 'skill'`
7. Run extraction on SKILL.md body for entity references and explicit
   skill relations
8. Set initial importance to `importanceOnInstall` (default 0.7)

### 4. Skill uninstallation

On remove:
1. Remove filesystem artifact (existing behavior)
2. Remove skill relation edges from `relations`
3. Remove skill mention links from `memory_entity_mentions`
4. Hard-delete entity row + `skill_meta` row in same write transaction

### 5. Filesystem reconciler

- Startup backfill: scan `~/.agents/skills/*/SKILL.md`, create nodes
  for any installed skill missing from graph
- Periodic reconciler: same scan on interval (`reconcileIntervalMs`,
  default 60000)
- File watcher: watch `~/.agents/skills/**/SKILL.md` for low-latency
  reconciliation
- If graph node exists but file is missing: execute uninstall flow
- Idempotent: matched by canonical name + frontmatter hash

### 6. Configuration

Add under `PipelineV2Config` in `packages/core/src/types.ts`:

```typescript
readonly procedural?: {
  readonly enabled: boolean;           // default true
  readonly decayRate: number;          // default 0.99
  readonly minImportance: number;      // default 0.3
  readonly importanceOnInstall: number; // default 0.7
  readonly enrichOnInstall: boolean;   // default true
  readonly enrichMinDescription: number; // default 30
  readonly reconcileIntervalMs: number; // default 60000
};
```

Wire defaults in `packages/daemon/src/memory-config.ts`.

## Key Files

- `packages/core/src/migrations/` — new migration goes here
- `packages/core/src/migrations/index.ts` — register migration
- `packages/core/src/types.ts` — add procedural config
- `packages/core/src/skills.ts` — existing skill registry
- `packages/daemon/src/memory-config.ts` — wire config defaults
- `packages/daemon/src/pipeline/provider.ts` — LlmProvider for enrichment
- `packages/daemon/src/pipeline/decision.ts` — existing extraction prompts
- `packages/daemon/src/db-accessor.ts` — ReadDb/WriteDb typed accessor
- `packages/daemon/src/db-helpers.ts` — vector blob helpers
- `packages/daemon/src/daemon.ts` — file watcher, API routes

## What NOT to Build (P2+)

- `/api/skills/used` endpoint (P2)
- `/api/skills/suggest` endpoint (P4)
- Skill-to-skill affinity computation (P3)
- Dashboard skill graph visualization (P5)
- `?ranked=true` on skill listing (P4)

## Verification

1. `bun run build` — no type errors
2. `bun test` — existing tests pass
3. `bun run typecheck` — clean
4. Install a skill, verify entity + skill_meta + embedding created
5. Uninstall a skill, verify hard-delete cleanup
6. Restart daemon, verify backfill creates nodes for existing skills
7. Delete a SKILL.md file, verify reconciler uninstalls the graph node
8. Verify enrichment writes back to SKILL.md frontmatter (YAML roundtrip)
9. Verify `agent_id = 'default'` on all created rows

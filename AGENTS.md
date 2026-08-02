---
Repo: "github.com/Signet-AI/signetai"
Canonical guide: "AGENTS.md (`CLAUDE.md` is a symlink)"
---

# Working in Signet

Signet is a local-first memory and context layer for AI agents. This file is
the repo-wide routing guide plus the few gotchas that are costly to rediscover.
Load deeper instructions only when the task reaches that area. Follow the
nearest scoped `AGENTS.md`, relevant source, and tests; let the user request and
surrounding code determine ordinary implementation choices.

## Start with the checkout

- Inspect `git status`, the files involved, their callers, and adjacent tests
  before deciding what should change.
- Treat current code and executable tests as the source of truth for shipped
  behavior. Plans, issues, mockups, and specs are useful references, but label
  planned behavior rather than presenting it as current.
- Preserve unrelated work. Do not reset, overwrite, rename, or delete changes
  you did not create unless the user explicitly asks.
- Never expose secrets in chat, logs, fixtures, generated files, or source.
- If dependencies are missing, run `bun install` and retry once before
  reporting the first actionable failure.

## Find the right context

| Area | Path | Read when relevant |
|---|---|---|
| Core data, DB, search | `platform/core` | `docs/ARCHITECTURE.md`, `docs/SOURCES.md` |
| Daemon, API, pipeline | `platform/daemon` | `platform/daemon/AGENTS.md`, `docs/API.md`, `docs/AUTH.md`, `docs/PIPELINE.md` |
| Harness integrations | `integrations` | `integrations/AGENTS.md`, `docs/HOOKS.md`, matching repo under `references/` |
| CLI and apps | `surfaces` | area source and tests; `docs/DASHBOARD.md` for dashboard work |
| Reusable packages | `libs`, `plugins`, `dist/signetai` | package manifest and consumers |
| Marketing and docs site | `web` | local package scripts and content source |
| Repo structure and risk | repository root | `repo.map.yaml`, root `package.json` |

Do not mirror package lists, build chains, routes, or schemas into guidance
when the owning manifest, source, or reference document can answer the
question directly.

## Durable data contracts

- User-data operations are agent-scoped. Preserve the agent identity across
  API (`agentId`), database (`agent_id`), headers, jobs, and derived rows; do
  not substitute `"default"` when a real identity is known. Carry
  `visibility` wherever the model supports it.
- Reject or explicitly authorize cross-agent reads, links, proposal applies,
  claim updates, and token scopes. Authentication and source-access failures
  should fail closed.
- Source artifacts and transcripts are evidence. Derived memories, claims,
  and relationships may change without rewriting their source evidence.
  Source-backed rows retain attribution and remain purgeable by source.
- Workspace resolution is `SIGNET_PATH` → `SIGNET_WORKSPACE` →
  `$HOME/.agents/`. Internal state belongs in the workspace SQLite database.
  JSON, JSONL, and text sidecars are for named user-facing artifacts such as
  import/export, attachments, logs, or backups—not default app state.
- Runtime reads canonical configuration only. A compatibility migration may
  rewrite old config into the canonical form, but do not add parallel readers
  or silent fallback executors.

## Verification

- Match proof to the risk and the user-visible boundary. Prefer behavioral
  tests; a bug fix normally includes the smallest regression test that would
  have caught it.
- Static checks are not runtime proof. Exercise the installed daemon, CLI,
  desktop shell, integration, browser extension, or generated package when the
  failure depends on that surface.
- For dependency-backed behavior, inspect the dependency's current source,
  types, or official documentation. Test a live external API when the claim
  depends on its current behavior. If required proof is unavailable, state
  exactly what is missing instead of guessing.
- Use focused checks first. Root scripts are defined in `package.json`; common
  entry points are `bun test`, `bun run lint`, `bun run typecheck`, and
  `bun run build`.

## Documentation parity

- Update behavior, API, schema, and user-facing documentation together when
  the change affects them. Keep `docs/API.md` aligned with daemon routes.
- Root documents duplicated under `docs/` are generated. Edit the root source,
  then run `bun scripts/sync-root-docs.ts`; do not hand-edit generated copies
  such as `docs/CONTRIBUTING.md` or `docs/ROADMAP.md`.
- Use `bun scripts/doc-drift.ts` when architecture or migration documentation
  may have drifted.

## Code and Git

- Match surrounding code: TypeScript is strict, external boundaries use the
  existing validation patterns, and public APIs should stay narrow.
- Use **Signet** for the product and prose; use `signet` for CLI, package,
  path, and configuration names. Write American English.
- Branch from `main` as `<username>/<feature>`. Use
  `type(scope): subject`; reserve `feat:` for user-facing features. Keep one
  PR to one topic, rebase before landing, and do not create merge commits on
  `main`.
- For GitHub issue, PR, and review bodies, pass real multiline text (for
  example, `-F - <<'EOF'`); do not embed escaped `\n` sequences.
- See `CONTRIBUTING.md` for fuller contribution and style guidance.

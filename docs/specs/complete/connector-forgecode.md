---
title: "Connector: ForgeCode"
id: connector-forgecode
status: complete
informed_by:
  - docs/research/technical/RESEARCH-REFERENCE-REPOS.md
section: "Connectors"
depends_on:
  - "signet-runtime"
success_criteria:
  - "ForgeCode loads Signet-managed global instructions from `~/forge/AGENTS.md` without requiring users to duplicate identity files by hand"
  - "ForgeCode sees Signet skills via `~/forge/skills` and keeps user-owned non-symlinked skill directories intact"
  - "ForgeCode discovers Signet MCP tools from `~/forge/.mcp.json` while preserving unrelated MCP servers"
  - "`signet setup --harness forge` performs the connector install after binary provisioning instead of leaving Forge integration as a no-op"
scope_boundary: "Covers the TypeScript connector that prepares ForgeCode's global AGENTS.md, skills, and MCP config; does not modify ForgeCode source, add lifecycle hooks that ForgeCode does not expose, or replace Signet's first-party Forge binary management flow"
draft_quality: "implementation-aligned"
---

# Connector: ForgeCode

Spec metadata:
- ID: `connector-forgecode`
- Status: `complete`
- Hard depends on: `signet-runtime`
- Registry: `docs/specs/INDEX.md`

Related docs:
- `packages/connector-base/src/index.ts`
- `references/forgecode/crates/forge_domain/src/env.rs`
- `references/forgecode/crates/forge_services/src/instructions.rs`
- `references/forgecode/crates/forge_domain/src/mcp.rs`

---

## 1) Problem

ForgeCode already has three extension points that line up with Signet's portable
surface area:

1. global custom instructions at `~/forge/AGENTS.md`
2. global skills at `~/forge/skills/<skill>/SKILL.md`
3. user-scope MCP config at `~/forge/.mcp.json`

But Signet currently treats `forge` as only a managed binary install. After the
binary is present, CLI setup does not bridge Signet identity, skills, or MCP
into ForgeCode's runtime layout. Users therefore lose most of Signet's value
unless they manually copy files into ForgeCode's directories.

## 2) Goals

1. Ship `@signet/connector-forge` as a `BaseConnector` subclass.
2. Generate a Signet-managed `~/forge/AGENTS.md` from the selected workspace.
3. Link Signet skills into `~/forge/skills` without overwriting real user
   directories.
4. Register Signet's MCP server in `~/forge/.mcp.json`.
5. Make `signet setup --harness forge` run the connector automatically.

## 3) Proposed capability set

### A) Global instructions bridge

ForgeCode loads custom instructions from `environment.global_agentsmd_path()`,
which resolves to `~/forge/AGENTS.md`. The connector should generate that file
from:

- `AGENTS.md`
- `SOUL.md`
- `IDENTITY.md`
- `USER.md`
- `MEMORY.md`

The generated file must be marked as Signet-managed so uninstall can remove only
its own output.

### B) Skill bridge

ForgeCode loads global skills from `~/forge/skills` and project-local skills
from `./.forge/skills`. Signet already stores portable skills as directories with
`SKILL.md` plus optional resources, which matches ForgeCode's loader contract.
The connector only needs to symlink Signet workspace skills into the global
ForgeCode skill directory.

### C) MCP bridge

ForgeCode merges MCP servers from `~/forge/.mcp.json` and project-local
`.mcp.json`, using the same top-level `mcpServers` shape Claude Code uses. The
connector should add a user-scope `signet` stdio server pointing at
`signet-mcp`, preserving unrelated MCP entries.

### D) No lifecycle hook claim

Unlike Claude Code, Codex, or OpenCode, ForgeCode does not expose an external
session lifecycle hook configuration surface in the reference repo. This
connector therefore does **not** attempt to fake `session-start` or
`session-end` hooks. The integration contract is limited to identity, skills,
and MCP tools until ForgeCode adds a supported hook/plugin API.

## 4) Non-goals

- No patching of ForgeCode's Rust source or shell plugin.
- No replacement of Signet's first-party Forge binary management commands.
- No transcript extraction bridge through unsupported lifecycle hooks.
- No project-local `.forge/` scaffolding inside user repositories.

## 5) Integration contracts

### Connector <-> ForgeCode

- Managed global instructions live at `~/forge/AGENTS.md`.
- Managed skills live under `~/forge/skills`.
- Managed MCP registration lives in `~/forge/.mcp.json`.
- Existing non-Signet MCP entries and real skill directories remain untouched.

### Connector <-> CLI setup

- `configureHarnessHooks("forge", ...)` installs the ForgeCode connector.
- Fresh setup may still provision the managed Forge binary first.
- Connector install remains safe for users running upstream-compatible ForgeCode
  binaries instead of the Signet-managed one.

### Connector <-> Signet runtime

- ForgeCode reaches Signet functionality through MCP tools, not daemon hook
  callbacks.
- Workspace identity remains sourced from the selected Signet base path.

## 6) Validation and tests

- Install writes `~/forge/AGENTS.md` with Signet-managed marker.
- Install merges `signet` into `~/forge/.mcp.json` without removing other
  servers.
- Install symlinks Signet skill directories into `~/forge/skills`.
- Uninstall removes only Signet-managed AGENTS/MCP entries.
- CLI setup path invokes the connector for `forge` instead of no-op behavior.

## 7) Open decisions

1. Whether ForgeCode eventually exposes a stable lifecycle hook surface worth
   mapping to Signet daemon hooks.
2. Whether the connector should later mirror Signet prompt commands into
   ForgeCode's `~/forge/commands` directory.
3. Whether ForgeCode-specific agent metadata should eventually be generated from
   `agent.yaml` beyond the composed markdown identity.

---
title: "OpenClaw Legacy Plugin Migration"
id: openclaw-legacy-plugin-migration
status: planning
informed_by:
  - docs/research/technical/notebook-dump-2026-02-25.md
  - docs/research/technical/RESEARCH-OPENCLAW-WORKSPACE-PROTECTION.md
section: "OpenClaw"
depends_on:
  - "openclaw-hardening"
  - "signet-runtime"
success_criteria:
  - "Legacy-only OpenClaw configs are auto-migrated to the plugin runtime path during `signet sync`"
  - "`signet doctor` flags legacy-only OpenClaw runtime state with a remediation command"
  - "Regression tests cover the upgrade path from legacy-only config to plugin runtime activation"
scope_boundary: "CLI sync/status/doctor guardrails only; no redesign of the OpenClaw plugin runtime"
draft_quality: "incident-driven planning stub"
---

# OpenClaw Legacy Plugin Migration

## Problem

Users who installed Signet before the OpenClaw plugin adapter shipped can stay
stuck on the legacy hook path forever. `signet sync` currently respects the
legacy config and never installs or activates the plugin runtime, so full
lifecycle capture remains silently disabled.

## Goals

1. Make the common upgrade path self-healing.
2. Keep the degraded legacy-only condition visible in diagnostics.
3. Add regression coverage so future sync changes do not reintroduce the trap.

## Proposed guardrails

1. `signet sync` upgrades legacy-only OpenClaw configs to the plugin path.
2. `signet doctor` warns when OpenClaw is still on the legacy-only path.
3. Sync output explains that the migration restored full lifecycle capture.
4. Tests cover legacy-only, plugin, and dual-runtime states.

/**
 * Tests for dreaming memory consolidation.
 *
 * Tests the threshold check, state management, mutation parsing/application,
 * and pass lifecycle -- all without an LLM (the generate function is mocked).
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DreamingConfig } from "@signet/core";
import { runMigrations } from "../../../core/src/migrations";
import type { DbAccessor } from "../db-accessor";
import {
	getDreamingPasses,
	getDreamingState,
	recordDreamingFailure,
	runDreamingPass,
	shouldTriggerDreaming,
} from "./dreaming";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const AGENT = "default";

function defaultCfg(overrides?: Partial<DreamingConfig>): DreamingConfig {
	return {
		enabled: true,
		tokenThreshold: 100_000,
		maxInputTokens: 32_000,
		maxOutputTokens: 16_000,
		timeout: 300_000,
		backfillOnFirstRun: true,
		...overrides,
	};
}

/** Minimal DbAccessor wrapper around an in-memory Database. */
function wrapDb(db: Database): DbAccessor {
	return {
		withReadDb<T>(fn: (db: Database) => T): T {
			return fn(db);
		},
		withWriteTx<T>(fn: (db: Database) => T): T {
			db.exec("BEGIN IMMEDIATE");
			try {
				const result = fn(db);
				db.exec("COMMIT");
				return result;
			} catch (e) {
				db.exec("ROLLBACK");
				throw e;
			}
		},
	} as unknown as DbAccessor;
}

function seedEntity(db: Database, id: string, name: string, type = "concept"): void {
	const canonical = name.trim().toLowerCase().replace(/\s+/g, " ");
	db.prepare(
		`INSERT INTO entities (id, name, canonical_name, entity_type, agent_id, mentions, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, 1, datetime('now'), datetime('now'))`,
	).run(id, name, canonical, type, AGENT);
}

function seedAspect(db: Database, id: string, entityId: string, name: string): void {
	const canonical = name.trim().toLowerCase().replace(/\s+/g, " ");
	db.prepare(
		`INSERT INTO entity_aspects (id, entity_id, agent_id, name, canonical_name, weight, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, 0.5, datetime('now'), datetime('now'))`,
	).run(id, entityId, AGENT, name, canonical);
}

function seedAttribute(db: Database, id: string, aspectId: string, content: string, kind = "attribute"): void {
	const normalized = content.trim().toLowerCase();
	db.prepare(
		`INSERT INTO entity_attributes (id, aspect_id, agent_id, kind, content, normalized_content, confidence, importance, status, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, 0.8, 0.5, 'active', datetime('now'), datetime('now'))`,
	).run(id, aspectId, AGENT, kind, content, normalized);
}

function seedSummary(db: Database, id: string, content: string, tokens: number): void {
	db.prepare(
		`INSERT INTO session_summaries (id, agent_id, content, token_count, depth, kind, source_type, earliest_at, latest_at, created_at)
		 VALUES (?, ?, ?, ?, 0, 'session', 'summary', datetime('now'), datetime('now'), datetime('now'))`,
	).run(id, AGENT, content, tokens);
}

function seedArtifact(db: Database, content: string): void {
	db.prepare(
		`INSERT INTO memory_artifacts
		 (agent_id, source_path, source_sha256, source_kind, session_id, session_key, session_token,
		  captured_at, content, updated_at, is_deleted)
		 VALUES (?, 'sources/roadmap.md', 'sha', 'source_obsidian_markdown', 'artifact-session', 'artifact-session', 'token',
		  datetime('now'), ?, datetime('now'), 0)`,
	).run(AGENT, content);
}

function seedTranscript(db: Database, content: string): void {
	db.prepare(
		`INSERT INTO session_transcripts
		(session_key, content, harness, agent_id, created_at, updated_at)
		VALUES ('episodic-session', ?, 'pi', ?, datetime('now'), datetime('now'))`,
	).run(content, AGENT);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("dreaming", () => {
	let db: Database;
	let accessor: DbAccessor;

	beforeEach(() => {
		db = new Database(":memory:");
		runMigrations(db as unknown as Parameters<typeof runMigrations>[0]);
		accessor = wrapDb(db);
	});

	afterEach(() => {
		db.close();
	});

	function withTempIdentity(files: Record<string, string>): string {
		const dir = mkdtempSync(join(tmpdir(), "dreaming-identity-"));
		for (const [name, content] of Object.entries(files)) {
			writeFileSync(join(dir, name), content);
		}
		return dir;
	}

	describe("state management", () => {
		it("returns empty state for a new agent", () => {
			const state = getDreamingState(accessor, AGENT);
			expect(state.lastPassAt).toBeNull();
			expect(state.lastPassMode).toBeNull();
		});
	});

	describe("threshold check", () => {
		it("does not trigger when disabled", () => {
			seedSummary(db, "disabled", "episodic source ".repeat(100), 100);
			expect(shouldTriggerDreaming(accessor, defaultCfg({ enabled: false }), AGENT)).toBe(false);
		});

		it("does not trigger below threshold", () => {
			seedSummary(db, "below-threshold", "episodic source ".repeat(10), 10);
			expect(
				shouldTriggerDreaming(accessor, defaultCfg({ tokenThreshold: 1_000, backfillOnFirstRun: false }), AGENT),
			).toBe(false);
		});

		it("triggers at threshold", () => {
			seedSummary(db, "at-threshold", "episodic source", 2);
			expect(shouldTriggerDreaming(accessor, defaultCfg({ tokenThreshold: 1 }), AGENT)).toBe(true);
		});

		it("triggers on first run with backfill", () => {
			seedSummary(db, "first-backfill", "episodic source", 2);
			expect(shouldTriggerDreaming(accessor, defaultCfg({ backfillOnFirstRun: true }), AGENT)).toBe(true);
		});

		it("does not trigger on first run without backfill", () => {
			expect(shouldTriggerDreaming(accessor, defaultCfg({ backfillOnFirstRun: false }), AGENT)).toBe(false);
		});

		it("backs off on consecutive failures", () => {
			// First failure: requires 2x threshold
			seedSummary(db, "first-backlog", "episodic source ".repeat(10), 10);
			recordDreamingFailure(accessor, AGENT);
			const cfg = defaultCfg({ tokenThreshold: 100, backfillOnFirstRun: false });
			// At 1 failure, need 2x threshold — the current evidence is below it.
			expect(shouldTriggerDreaming(accessor, cfg, AGENT)).toBe(false);
			// More episodic evidence clears the backoff threshold.
			seedSummary(db, "second-backlog", "episodic source ".repeat(300), 300);
			expect(shouldTriggerDreaming(accessor, cfg, AGENT)).toBe(true);
		});

		it("backs off first-run failures requiring threshold tokens", () => {
			// First-run with backfill but has failures — requires tokenThreshold
			recordDreamingFailure(accessor, AGENT);
			const cfg = defaultCfg({ backfillOnFirstRun: true, tokenThreshold: 10 });
			// No tokens: would normally trigger on first run, but failure backoff blocks
			expect(shouldTriggerDreaming(accessor, cfg, AGENT)).toBe(false);
			// Episodic evidence reaches the retry threshold.
			seedSummary(db, "failure-backfill", "episodic source ".repeat(20), 20);
			expect(shouldTriggerDreaming(accessor, cfg, AGENT)).toBe(true);
		});
	});

	describe("pass lifecycle", () => {
		it("completes pass with no data gracefully", async () => {
			const generate = async () => JSON.stringify({ operations: [], summary: "Nothing to do" });

			const tmpDir = "/tmp";
			const result = await runDreamingPass(accessor, generate, defaultCfg(), tmpDir, AGENT, "incremental");
			expect(result.applied).toBe(0);
			expect(result.failed).toBe(0);
			expect(result.summary).toBe("No new episodic evidence or semantic entities to process");
		});

		it("records pass history", async () => {
			// Seed some data so we get past the empty check
			seedEntity(db, "ent-1", "TypeScript", "tool");
			seedAspect(db, "asp-1", "ent-1", "usage");
			seedAttribute(db, "attr-1", "asp-1", "TypeScript is used for all backend code");

			const generate = async () => JSON.stringify({ operations: [], summary: "Reviewed graph, no changes needed" });

			await runDreamingPass(accessor, generate, defaultCfg(), "/tmp", AGENT, "compact");
			const passes = getDreamingPasses(accessor, AGENT);
			expect(passes.length).toBe(1);
			expect(passes[0]?.mode).toBe("compact");
			expect(passes[0]?.status).toBe("completed");
		});

		it("reasons over artifacts, transcripts, and temporal summaries as episodic evidence", async () => {
			seedArtifact(db, "The source artifact records the roadmap decision.");
			seedTranscript(db, "The live transcript records the implementation discussion.");
			db.prepare(
				`INSERT INTO session_summaries
				 (id, agent_id, content, token_count, depth, kind, source_type, earliest_at, latest_at, created_at)
				 VALUES ('compact-evidence', ?, 'The compaction preserves temporal lineage.', 7, 0, 'session', 'compaction',
				         datetime('now'), datetime('now'), datetime('now'))`,
			).run(AGENT);
			let prompt = "";
			await runDreamingPass(
				accessor,
				async (input) => {
					prompt = input;
					return JSON.stringify({ operations: [], summary: "Reviewed episodic evidence" });
				},
				defaultCfg(),
				"/tmp",
				AGENT,
				"incremental",
			);
			expect(prompt).toContain("<episodic_evidence>");
			expect(prompt).toContain("artifact:source_obsidian_markdown");
			expect(prompt).toContain("The source artifact records the roadmap decision.");
			expect(prompt).toContain("transcript:transcript");
			expect(prompt).toContain("The live transcript records the implementation discussion.");
			expect(prompt).toContain("summary:compaction");
			expect(prompt).toContain("The compaction preserves temporal lineage.");
		});

		it("keeps evidence created during a pass eligible for the next pass", async () => {
			db.prepare(
				`INSERT INTO session_summaries
				 (id, agent_id, content, token_count, depth, kind, source_type, earliest_at, latest_at, created_at)
				 VALUES ('before-pass', ?, 'Evidence selected by the first pass.', 7, 0, 'session', 'summary',
				         '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z')`,
			).run(AGENT);
			await runDreamingPass(
				accessor,
				async () => {
					db.prepare(
						`INSERT INTO session_summaries
						 (id, agent_id, content, token_count, depth, kind, source_type, earliest_at, latest_at, created_at)
						 VALUES ('during-pass', ?, 'Evidence captured while the pass was running.', 8, 0, 'session', 'summary',
						         '2026-08-01T00:00:01.000Z', '2026-08-01T00:00:01.000Z', '2026-08-01T00:00:01.000Z')`,
					).run(AGENT);
					return JSON.stringify({ operations: [], summary: "First pass" });
				},
				defaultCfg(),
				"/tmp",
				AGENT,
				"incremental",
			);
			let nextPrompt = "";
			await runDreamingPass(
				accessor,
				async (input) => {
					nextPrompt = input;
					return JSON.stringify({ operations: [], summary: "Second pass" });
				},
				defaultCfg(),
				"/tmp",
				AGENT,
				"incremental",
			);
			expect(nextPrompt).toContain("Evidence captured while the pass was running.");
		});

		it("advances the episodic cursor through ties only as far as the selected batch", async () => {
			for (let index = 0; index < 201; index++) {
				const capturedAt = "2026-08-01T00:00:00.000Z";
				db.prepare(
					`INSERT INTO session_summaries
					 (id, agent_id, content, token_count, depth, kind, source_type, earliest_at, latest_at, created_at)
					 VALUES (?, ?, ?, 3, 0, 'session', 'summary', ?, ?, ?)`,
				).run(
					`batch-${String(index).padStart(3, "0")}`,
					AGENT,
					`Evidence ${index}`,
					capturedAt,
					capturedAt,
					capturedAt,
				);
			}
			let firstPrompt = "";
			await runDreamingPass(
				accessor,
				async (input) => {
					firstPrompt = input;
					return JSON.stringify({ operations: [], summary: "First batch" });
				},
				defaultCfg(),
				"/tmp",
				AGENT,
				"incremental",
			);
			expect(firstPrompt).toContain("Evidence 0");
			expect(firstPrompt).toContain("Evidence 199");
			expect(firstPrompt).not.toContain("Evidence 200");
			let secondPrompt = "";
			await runDreamingPass(
				accessor,
				async (input) => {
					secondPrompt = input;
					return JSON.stringify({ operations: [], summary: "Second batch" });
				},
				defaultCfg(),
				"/tmp",
				AGENT,
				"incremental",
			);
			expect(secondPrompt).toContain("Evidence 200");
		});

		it("does not advance past fetched evidence omitted by the prompt budget", async () => {
			for (const [id, content, capturedAt] of [
				["budget-first", `FIRST_EVIDENCE ${"first evidence ".repeat(500)}`, "2026-08-01T00:00:00.000Z"],
				["budget-second", `SECOND_EVIDENCE ${"second evidence ".repeat(500)}`, "2026-08-01T00:00:01.000Z"],
			] as const) {
				db.prepare(
					`INSERT INTO session_summaries
					 (id, agent_id, content, token_count, depth, kind, source_type, earliest_at, latest_at, created_at)
					 VALUES (?, ?, ?, 2500, 0, 'session', 'summary', ?, ?, ?)`,
				).run(id, AGENT, content, capturedAt, capturedAt, capturedAt);
			}
			const cfg = defaultCfg({ maxInputTokens: 8_000 });
			let firstPrompt = "";
			await runDreamingPass(
				accessor,
				async (input) => {
					firstPrompt = input;
					return JSON.stringify({ operations: [], summary: "First budget pass" });
				},
				cfg,
				"/tmp",
				AGENT,
				"incremental",
			);
			expect(firstPrompt).toContain("FIRST_EVIDENCE");
			expect(firstPrompt).not.toContain("SECOND_EVIDENCE");
			let secondPrompt = "";
			await runDreamingPass(
				accessor,
				async (input) => {
					secondPrompt = input;
					return JSON.stringify({ operations: [], summary: "Second budget pass" });
				},
				cfg,
				"/tmp",
				AGENT,
				"incremental",
			);
			expect(secondPrompt).toContain("SECOND_EVIDENCE");
		});

		it("fails without advancing when the first episodic source cannot fit", async () => {
			db.prepare(
				`INSERT INTO session_summaries
				 (id, agent_id, content, token_count, depth, kind, source_type, earliest_at, latest_at, created_at)
				 VALUES ('oversize-first', ?, ?, 9000, 0, 'session', 'summary',
				         '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z')`,
			).run(AGENT, `OVERSIZE_EVIDENCE ${"large evidence ".repeat(3_000)}`);
			await expect(
				runDreamingPass(
					accessor,
					async () => JSON.stringify({ operations: [], summary: "should not run" }),
					defaultCfg({ maxInputTokens: 8_000 }),
					"/tmp",
					AGENT,
					"incremental",
				),
			).rejects.toThrow("oversize-first exceeds the Dreaming prompt budget");
			expect(getDreamingState(accessor, AGENT).evidenceCursor).toBeNull();
			expect(getDreamingPasses(accessor, AGENT)[0]?.status).toBe("failed");
		});

		it("loads configured startup identity and DREAMING.md special prompt", async () => {
			seedEntity(db, "ent-1", "Signet", "project");
			const dir = withTempIdentity({
				"agent.yaml":
					"identity:\n  preset: minimal\n  startup:\n    load:\n      - path: AGENTS.md\n        role: startup_rules\n        budget: 12000\n  special:\n    - path: DREAMING.md\n      kind: dreaming\n      role: dreaming_prompt\n      budget: 4000\n",
				"AGENTS.md": "Startup rules are loaded normally.",
				"MEMORY.md": "Minimal preset memory should not be injected implicitly.",
				"SOUL.md": "Soul should not be loaded by the minimal startup preset.",
				"DREAMING.md": "Dreaming-specific reflection instructions.",
			});
			try {
				const generate = async (prompt: string) => {
					expect(prompt).toContain("Startup rules are loaded normally.");
					expect(prompt).toContain("Dreaming-specific reflection instructions.");
					expect(prompt).toContain("create_entity|create_aspect|add_claim_value|set_claim_value");
					expect(prompt).toContain('"evidence"');
					expect(prompt).toContain("<dreaming_prompt>");
					expect(prompt).not.toContain("Soul should not be loaded");
					expect(prompt).not.toContain("Minimal preset memory should not be injected implicitly.");
					return JSON.stringify({ operations: [], summary: "Prompt inspected" });
				};

				await runDreamingPass(accessor, generate, defaultCfg(), dir, AGENT, "compact");
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		});

		it("keeps startup MEMORY.md in the working_memory block without duplicating identity", async () => {
			seedEntity(db, "ent-1", "Signet", "project");
			const dir = withTempIdentity({
				"agent.yaml":
					"identity:\n  preset: openclaw\n  startup:\n    load:\n      - path: AGENTS.md\n        role: startup_rules\n      - path: MEMORY.md\n        role: working_memory\n  special:\n    - path: DREAMING.md\n      kind: dreaming\n      role: dreaming_prompt\n",
				"AGENTS.md": "Startup rules are loaded normally.",
				"MEMORY.md": "Memory appears exactly once.",
				"DREAMING.md": "Dreaming-specific reflection instructions.",
			});
			try {
				const generate = async (prompt: string) => {
					expect(prompt.match(/Memory appears exactly once\./g)?.length).toBe(1);
					expect(prompt).toContain("<working_memory>\nMemory appears exactly once.\n</working_memory>");
					return JSON.stringify({ operations: [], summary: "Prompt inspected" });
				};

				await runDreamingPass(accessor, generate, defaultCfg(), dir, AGENT, "compact");
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		});

		it("applies provenance-backed ontology operations atomically", async () => {
			const evidence = "Nexus is a Rust project the user is building.";
			seedSummary(db, "s-1", evidence, 10);
			const generate = async () =>
				JSON.stringify({
					operations: [
						{
							operation: "create_entity",
							payload: { name: "Nexus", entity_type: "project" },
							reason: "The episodic evidence identifies a durable project.",
							confidence: 0.9,
							evidence: [{ source_kind: "summary", source_id: "s-1", quote: evidence }],
						},
					],
					summary: "Created the Nexus project entity",
				});

			const result = await runDreamingPass(accessor, generate, defaultCfg(), "/tmp", AGENT, "incremental");
			expect(result.applied).toBe(1);
			const entity = db
				.prepare("SELECT proposal_id FROM entities WHERE agent_id = ? AND canonical_name = 'nexus'")
				.get(AGENT) as { proposal_id: string | null } | undefined;
			expect(entity?.proposal_id).toBeString();
		});

		it("records failed pass on LLM error", async () => {
			seedEntity(db, "ent-1", "Test", "concept");

			const generate = async (): Promise<string> => {
				throw new Error("LLM timeout");
			};

			await expect(runDreamingPass(accessor, generate, defaultCfg(), "/tmp", AGENT, "incremental")).rejects.toThrow(
				"LLM timeout",
			);

			const passes = getDreamingPasses(accessor, AGENT);
			expect(passes.length).toBe(1);
			expect(passes[0]?.status).toBe("failed");
			expect(passes[0]?.error).toBe("LLM timeout");
		});

		it("handles malformed LLM response gracefully", async () => {
			seedEntity(db, "ent-1", "Test", "concept");

			const generate = async () => "this is not json at all!!!";

			await expect(runDreamingPass(accessor, generate, defaultCfg(), "/tmp", AGENT, "incremental")).rejects.toThrow();

			const passes = getDreamingPasses(accessor, AGENT);
			expect(passes[0]?.status).toBe("failed");
		});

		it("accepts valid JSON after a reasoning preamble", async () => {
			seedEntity(db, "ent-1", "Test", "concept");
			const response = JSON.stringify({ operations: [], summary: "Reviewed graph after reasoning" });
			const generate = async () => `Looking at {graph} before deciding...\n${response}\nDone.`;

			const result = await runDreamingPass(accessor, generate, defaultCfg(), "/tmp", AGENT, "incremental");

			expect(result.summary).toBe("Reviewed graph after reasoning");
		});

		it("accepts fenced JSON after a reasoning preamble", async () => {
			seedEntity(db, "ent-1", "Test", "concept");
			const response = JSON.stringify({ operations: [], summary: "Reviewed fenced result" });
			const generate = async () => `Looking at the graph...\n\`\`\`json\n${response}\n\`\`\``;

			const result = await runDreamingPass(accessor, generate, defaultCfg(), "/tmp", AGENT, "incremental");

			expect(result.summary).toBe("Reviewed fenced result");
		});

		it("keeps braces, escaped quotes, and backslashes inside JSON strings balanced", async () => {
			seedEntity(db, "ent-1", "Test", "concept");
			const summary = 'Reviewed {draft}, the "quoted" value, and C:\\temp';
			const response = JSON.stringify({ operations: [], summary });
			const generate = async () => `Reasoning first.\n${response}`;

			const result = await runDreamingPass(accessor, generate, defaultCfg(), "/tmp", AGENT, "incremental");

			expect(result.summary).toBe(summary);
		});

		it("rejects malformed balanced output after a preamble", async () => {
			seedEntity(db, "ent-1", "Test", "concept");
			const generate = async () => 'Looking...\n{"mutations": nope, "summary": "broken"}';

			await expect(runDreamingPass(accessor, generate, defaultCfg(), "/tmp", AGENT, "incremental")).rejects.toThrow();
			expect(getDreamingPasses(accessor, AGENT)[0]?.status).toBe("failed");
		});

		it("records the cursor after a successful pass", async () => {
			seedEntity(db, "ent-1", "Test", "concept");

			const generate = async () => JSON.stringify({ operations: [], summary: "Nothing changed" });

			await runDreamingPass(accessor, generate, defaultCfg(), "/tmp", AGENT, "incremental");

			const state = getDreamingState(accessor, AGENT);
			expect(state.lastPassAt).not.toBeNull();
			expect(state.lastPassMode).toBe("incremental");
		});
	});
});

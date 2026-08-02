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
	_testParseEpisodicCursor,
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

/**
 * Seed an episodic memory row (user-owned explicit evidence). When
 * `evidenceMeta` is supplied it is stored verbatim in `evidence_meta`, giving
 * Dreaming structured facts to reason over. `sourceId` models the configured
 * Signet source entry id when set; episodic memories carry none by default.
 */
function seedEpisodicMemory(
	db: Database,
	id: string,
	content: string,
	opts?: { evidenceMeta?: string; sourceType?: string; sourceId?: string | null },
): void {
	db.prepare(
		`INSERT INTO memories
		 (id, content, normalized_content, content_hash, type, source_type, source_id, who, why,
		  importance, pinned, is_deleted, extraction_status, memory_kind, evidence_meta, agent_id,
		  visibility, created_at, updated_at, updated_by)
		 VALUES (?, ?, ?, ?, 'fact', ?, ?, 'test', 'explicit', 0.6, 0, 0, 'none', 'episodic', ?, ?, 'global',
		         datetime('now'), datetime('now'), 'test')`,
	).run(
		id,
		content,
		content.toLowerCase(),
		`hash-${id}`,
		opts?.sourceType ?? "manual",
		opts?.sourceId ?? null,
		opts?.evidenceMeta ?? null,
		AGENT,
	);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("parseEpisodicCursor round-trip", () => {
	it("accepts and preserves the memory episodic kind (#946)", () => {
		const cursor = { capturedAt: "2026-01-01T00:00:00.000Z", kind: "memory" as const, id: "mem-1" };
		const parsed = _testParseEpisodicCursor(JSON.stringify(cursor));
		expect(parsed).toEqual(cursor);
	});

	it("round-trips every episodic kind through JSON serialization", () => {
		for (const kind of ["memory", "artifact", "transcript", "summary"] as const) {
			const cursor = { capturedAt: "2026-03-01T00:00:00.000Z", kind, id: `id-${kind}` };
			const parsed = _testParseEpisodicCursor(JSON.stringify(cursor));
			expect(parsed).toEqual(cursor);
		}
	});

	it("round-trips a null-kind cursor (initial backfill boundary)", () => {
		const cursor = { capturedAt: "2026-01-01T00:00:00.000Z", kind: null, id: "" };
		const parsed = _testParseEpisodicCursor(JSON.stringify(cursor));
		expect(parsed).toEqual(cursor);
	});

	it("rejects unknown kinds and malformed payloads", () => {
		expect(_testParseEpisodicCursor(null)).toBeNull();
		expect(_testParseEpisodicCursor("not-json")).toBeNull();
		expect(_testParseEpisodicCursor(JSON.stringify({ capturedAt: "2026-01-01", kind: "unknown", id: "x" }))).toBeNull();
		expect(_testParseEpisodicCursor(JSON.stringify({ capturedAt: "2026-01-01", id: "x" }))).toBeNull();
	});
});

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

		it("keeps source-native topology out of semantic Dreaming context", async () => {
			seedEntity(db, "semantic", "Semantic Project", "project");
			seedEntity(db, "source-document", "Source Navigation Document", "source_document");
			seedAspect(db, "source-aspect", "source-document", "Source Topology");
			seedAttribute(db, "source-attribute", "source-aspect", "This belongs only to source-native navigation.");
			let prompt = "";
			await runDreamingPass(
				accessor,
				async (input) => {
					prompt = input;
					return JSON.stringify({ operations: [], summary: "Reviewed semantic graph only" });
				},
				defaultCfg(),
				"/tmp",
				AGENT,
				"compact",
			);
			expect(prompt).toContain("Semantic Project");
			expect(prompt).not.toContain("Source Navigation Document");
			expect(prompt).not.toContain("This belongs only to source-native navigation.");
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

		it("renders project and harness provenance in episodic evidence headings", async () => {
			// Regression (#946): harness provenance must reach the Dreaming prompt
			// heading alongside project, so the model can reason over the
			// originating context. These are display-only metadata labels; they do
			// not gate reads or change agent isolation.
			db.prepare(
				`INSERT INTO session_summaries
				 (id, agent_id, content, token_count, depth, kind, source_type, project, harness,
				  earliest_at, latest_at, created_at)
				 VALUES ('provenance-summary', ?, 'Provenance evidence.', 5, 0, 'session', 'summary',
				         'Meridian', 'obsidian',
				         datetime('now'), datetime('now'), datetime('now'))`,
			).run(AGENT);
			let prompt = "";
			await runDreamingPass(
				accessor,
				async (input) => {
					prompt = input;
					return JSON.stringify({ operations: [], summary: "Inspected provenance headings" });
				},
				defaultCfg(),
				"/tmp",
				AGENT,
				"incremental",
			);
			expect(prompt).toContain(" — Meridian · obsidian");
			expect(prompt).toContain("source_kind: summary");
			expect(prompt).toContain("source_id: provenance-summary");
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
					expect(prompt).toContain(
						"The payload field is the operation payload itself, never a map keyed by operation name.",
					);
					expect(prompt).toContain('"payload": { "name": "...", "entity_type": "project" }');
					expect(prompt).not.toContain('"create_entity": { "name"');
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

		it("uses an artifact's explicit provenance fields for audited operations", async () => {
			const evidence = "The roadmap names Meridian as the active project.";
			seedArtifact(db, evidence);
			const result = await runDreamingPass(
				accessor,
				async (prompt) => {
					expect(prompt).toContain("source_kind: source_obsidian_markdown");
					expect(prompt).toContain("source_id: artifact-session");
					expect(prompt).toContain("source_path: sources/roadmap.md");
					return JSON.stringify({
						operations: [
							{
								operation: "create_entity",
								payload: { name: "Meridian", entity_type: "project" },
								reason: "The source artifact names a durable project.",
								evidence: [
									{
										source_kind: "source_obsidian_markdown",
										source_id: "artifact-session",
										source_path: "sources/roadmap.md",
										quote: evidence,
									},
								],
							},
						],
						summary: "Created Meridian from the source artifact",
					});
				},
				defaultCfg(),
				"/tmp",
				AGENT,
				"incremental",
			);
			expect(result.applied).toBe(1);
			expect(
				db.prepare("SELECT name FROM entities WHERE agent_id = ? AND canonical_name = 'meridian'").get(AGENT),
			).toEqual({ name: "Meridian" });
		});

		it("purges dreaming-derived semantics by the configured Signet source id", async () => {
			// A Signet source artifact: source_id is the configured source entry id
			// (the purge key), source_node_id is the episodic node identity the LLM
			// echoes back as evidence source_id.
			const sourceEvidence = "The roadmap names Helix as the canonical deployment target.";
			db.prepare(
				`INSERT INTO memory_artifacts
				 (agent_id, source_path, source_sha256, source_kind, source_id, source_node_id,
				  session_id, session_key, session_token, captured_at, content, updated_at, is_deleted)
				 VALUES (?, 'sources/deploy.md', 'sha', 'source_obsidian_markdown', 'obsidian:signet',
				  'node-deploy', 'session-helix', 'session-helix', 'token-helix',
				 datetime('now'), ?, datetime('now'), 0)`,
			).run(AGENT, sourceEvidence);
			// Unrelated semantic claim from a different source that must survive purge.
			seedEntity(db, "unrelated", "Unrelated Project", "project");
			seedAspect(db, "unrelated-asp", "unrelated", "identity");
			seedAttribute(db, "unrelated-attr", "unrelated-asp", "This claim belongs to a different source.");
			db.prepare(`UPDATE entity_attributes SET source_id = 'other:source' WHERE id = ?`).run("unrelated-attr");

			const evidenceBlock = [
				{
					source_kind: "source_obsidian_markdown",
					source_id: "node-deploy",
					source_path: "sources/deploy.md",
					quote: sourceEvidence,
				},
			];
			const result = await runDreamingPass(
				accessor,
				async () =>
					JSON.stringify({
						operations: [
							{
								operation: "create_entity",
								payload: { name: "Helix", entity_type: "project" },
								reason: "The source artifact names the deployment target.",
								evidence: evidenceBlock,
							},
							{
								operation: "add_claim_value",
								payload: {
									entity: "Helix",
									aspect: "deployment",
									claim_key: "target",
									value: "Helix is the canonical deployment target.",
								},
								reason: "The source artifact records the deployment target.",
								evidence: evidenceBlock,
							},
						],
						summary: "Created Helix and its deployment claim from the artifact",
					}),
				defaultCfg(),
				"/tmp",
				AGENT,
				"incremental",
			);
			expect(result.applied).toBe(2);

			// The claim value is stamped with the configured source entry id, not the
			// episodic node id, so purge by source entry id removes it.
			const claimRow = db
				.prepare(
					`SELECT id FROM entity_attributes
					 WHERE agent_id = ? AND source_id = ? AND content LIKE ?`,
				)
				.get(AGENT, "obsidian:signet", "%canonical deployment target%") as { id: string } | undefined;
			expect(claimRow).toBeDefined();
			expect(
				(
					db.prepare("SELECT COUNT(*) AS n FROM entity_attributes WHERE source_id = ?").get("node-deploy") as {
						n: number;
					}
				).n,
			).toBe(0);

			// Unrelated source-owned claim is untouched before purge.
			expect(
				(
					db.prepare("SELECT COUNT(*) AS n FROM entity_attributes WHERE id = ?").get("unrelated-attr") as {
						n: number;
					}
				).n,
			).toBe(1);

			// Purge by the configured source entry id. This raw delete mirrors the
			// source_id predicate both purge paths use: purgeSourceOwnedRows
			// (GitHub/Discord providers) and purgeObsidianSourceStructure (Obsidian
			// disconnect, which also matches the dreaming-rooted derived rows).
			const purgedAttrs = db
				.prepare("DELETE FROM entity_attributes WHERE agent_id = ? AND source_id = ?")
				.run(AGENT, "obsidian:signet").changes;
			const purgedDeps = db
				.prepare("DELETE FROM entity_dependencies WHERE agent_id = ? AND source_id = ?")
				.run(AGENT, "obsidian:signet").changes;
			expect(purgedAttrs + purgedDeps).toBeGreaterThan(0);

			// The dreaming-derived claim value is removed.
			expect(
				(
					db.prepare("SELECT COUNT(*) AS n FROM entity_attributes WHERE id = ?").get(claimRow!.id) as {
						n: number;
					}
				).n,
			).toBe(0);
			// The unrelated source-owned claim survives the purge.
			expect(
				(
					db.prepare("SELECT COUNT(*) AS n FROM entity_attributes WHERE id = ?").get("unrelated-attr") as {
						n: number;
					}
				).n,
			).toBe(1);
		});

		it("prefers a source-entry provenance regardless of LLM evidence ordering", async () => {
			// Regression: provenance selection must prefer a matched evidence record
			// that owns a configured Signet source entry id, independent of the order
			// the LLM cites the evidence in. Citing a transcript first (no
			// sourceEntryId) and a Signet-source artifact second must still stamp the
			// source entry id so the derived semantic row is purgeable by source.
			const transcriptEvidence = "The transcript records the design review.";
			seedTranscript(db, transcriptEvidence);
			const artifactEvidence = "The roadmap names Vortex as the canonical deployment target.";
			db.prepare(
				`INSERT INTO memory_artifacts
				 (agent_id, source_path, source_sha256, source_kind, source_id, source_node_id,
				  session_id, session_key, session_token, captured_at, content, updated_at, is_deleted)
				 VALUES (?, 'sources/vortex.md', 'sha', 'source_obsidian_markdown', 'obsidian:vortex',
				  'node-vortex', 'session-vortex', 'session-vortex', 'token-vortex',
				 datetime('now'), ?, datetime('now'), 0)`,
			).run(AGENT, artifactEvidence);

			// The transcript is cited first; the Signet-source artifact second.
			const evidenceBlock = [
				{ source_kind: "transcript", source_id: "episodic-session", quote: transcriptEvidence },
				{
					source_kind: "source_obsidian_markdown",
					source_id: "node-vortex",
					source_path: "sources/vortex.md",
					quote: artifactEvidence,
				},
			];
			const result = await runDreamingPass(
				accessor,
				async () =>
					JSON.stringify({
						operations: [
							{
								operation: "add_claim_value",
								payload: {
									entity: "Vortex",
									aspect: "deployment",
									claim_key: "target",
									value: "Vortex is the canonical deployment target.",
								},
								reason: "The transcript and the source artifact record the deployment target.",
								evidence: evidenceBlock,
							},
						],
						summary: "Created the Vortex deployment claim from transcript and artifact",
					}),
				defaultCfg(),
				"/tmp",
				AGENT,
				"incremental",
			);
			expect(result.applied).toBe(1);

			// All three provenance fields come from the same selected source (the
			// Signet-source artifact cited second), not a mix of the transcript's
			// kind/path with the artifact's source entry id.
			const claimRow = db
				.prepare(
					`SELECT id, source_id, source_kind, source_path FROM entity_attributes
					 WHERE agent_id = ? AND content LIKE ?`,
				)
				.get(AGENT, "%canonical deployment target%") as
				| {
						id: string;
						source_id: string | null;
						source_kind: string | null;
						source_path: string | null;
				  }
				| undefined;
			expect(claimRow).toBeDefined();
			// sourceId is the configured source entry id, not the episodic node id.
			expect(claimRow!.source_id).toBe("obsidian:vortex");
			// sourceKind matches the selected artifact, not the transcript cited first.
			expect(claimRow!.source_kind).toBe("source_obsidian_markdown");
			// sourcePath matches the selected artifact, not the transcript's null path.
			expect(claimRow!.source_path).toBe("sources/vortex.md");
			expect(
				(
					db.prepare("SELECT COUNT(*) AS n FROM entity_attributes WHERE source_id = ?").get("episodic-session") as {
						n: number;
					}
				).n,
			).toBe(0);
			expect(
				(
					db.prepare("SELECT COUNT(*) AS n FROM entity_attributes WHERE source_kind = ?").get("transcript") as {
						n: number;
					}
				).n,
			).toBe(0);

			// Purge by the configured source entry id. This raw delete mirrors the
			// source_id predicate both purge paths use: purgeSourceOwnedRows
			// (GitHub/Discord providers) and purgeObsidianSourceStructure (Obsidian
			// disconnect, which also matches the dreaming-rooted derived rows).
			const purgedAttrs = db
				.prepare("DELETE FROM entity_attributes WHERE agent_id = ? AND source_id = ?")
				.run(AGENT, "obsidian:vortex").changes;
			expect(purgedAttrs).toBeGreaterThan(0);
			expect(
				(
					db.prepare("SELECT COUNT(*) AS n FROM entity_attributes WHERE id = ?").get(claimRow!.id) as {
						n: number;
					}
				).n,
			).toBe(0);
		});

		it("validates and applies an audited operation cited from structured-only evidence", async () => {
			// An episodic memory whose content is generic but whose structured
			// evidence carries the citable fact. The quote the LLM cites appears
			// only in the rendered structured text, never in `content`.
			const structuredQuote = "Aurora [owned-by] Dr. Vance";
			const evidenceMeta = JSON.stringify({
				entities: [{ source: "Aurora", relationship: "owned-by", target: "Dr. Vance" }],
				aspects: [{ entityName: "Aurora", aspect: "ownership" }],
			});
			seedEpisodicMemory(db, "mem-structured", "Saved a structured memory.", { evidenceMeta });

			let prompt = "";
			const result = await runDreamingPass(
				accessor,
				async (input) => {
					prompt = input;
					return JSON.stringify({
						operations: [
							{
								operation: "create_entity",
								payload: { name: "Aurora", entity_type: "project" },
								reason: "The structured evidence records a durable ownership relationship.",
								evidence: [{ source_kind: "manual", source_id: "mem-structured", quote: structuredQuote }],
							},
						],
						summary: "Created Aurora from structured evidence",
					});
				},
				defaultCfg(),
				"/tmp",
				AGENT,
				"incremental",
			);

			// The structured render is in the prompt...
			expect(prompt).toContain("structured_evidence:");
			expect(prompt).toContain("Aurora [owned-by] Dr. Vance");
			expect(prompt).toContain("Aurora/ownership");
			// ...but the quote never appears in the raw content.
			expect(prompt).toContain("Saved a structured memory.");
			// The structured citation validated and applied.
			expect(result.applied).toBe(1);
			expect(
				db.prepare("SELECT name FROM entities WHERE agent_id = ? AND canonical_name = 'aurora'").get(AGENT),
			).toEqual({ name: "Aurora" });
		});

		it("rejects an operation citing text absent from the rendered source form", async () => {
			// The quote is plausible prose that is NOT in content and NOT in the
			// rendered structured text. It must be rejected as unrendered/
			// unrelated text.
			const evidenceMeta = JSON.stringify({
				entities: [{ source: "Helios", relationship: "powers", target: "grid" }],
			});
			seedEpisodicMemory(db, "mem-structured-reject", "Saved a structured memory.", { evidenceMeta });

			const result = await runDreamingPass(
				accessor,
				async () =>
					JSON.stringify({
						operations: [
							{
								operation: "create_entity",
								payload: { name: "Helios", entity_type: "system" },
								reason: "Fabricated citation.",
								evidence: [
									{
										source_kind: "manual",
										source_id: "mem-structured-reject",
										quote: "Helios was decommissioned last quarter.",
									},
								],
							},
						],
						summary: "Should be discarded",
					}),
				defaultCfg(),
				"/tmp",
				AGENT,
				"incremental",
			);
			// The fabricated citation failed validation and was discarded.
			expect(result.applied).toBe(0);
			expect(result.failed).toBe(1);
			expect(
				db
					.prepare("SELECT COUNT(*) AS n FROM entities WHERE agent_id = ? AND canonical_name = 'helios'")
					.get(AGENT) as { n: number },
			).toEqual({ n: 0 });
		});

		it("keeps user-owned explicit memory out of source-disconnect purge scope", async () => {
			// User-owned explicit memory carries no configured Signet source
			// entry id, so Dreaming stamps the derived claim with the episodic
			// source id, not a purge key. Source-disconnect purge by a configured
			// source entry id must NOT remove it.
			const structuredQuote = "Solstice [integrates] Atlas";
			const evidenceMeta = JSON.stringify({
				entities: [{ source: "Solstice", relationship: "integrates", target: "Atlas" }],
			});
			seedEpisodicMemory(db, "mem-user-owned", "Saved a structured memory.", { evidenceMeta });

			const result = await runDreamingPass(
				accessor,
				async () =>
					JSON.stringify({
						operations: [
							{
								operation: "add_claim_value",
								payload: {
									entity: "Solstice",
									aspect: "integration",
									claim_key: "partner",
									value: "Solstice integrates Atlas.",
								},
								reason: "The structured evidence records the integration.",
								evidence: [{ source_kind: "manual", source_id: "mem-user-owned", quote: structuredQuote }],
							},
						],
						summary: "Created the Solstice integration claim from structured evidence",
					}),
				defaultCfg(),
				"/tmp",
				AGENT,
				"incremental",
			);
			expect(result.applied).toBe(1);

			// Provenance: stamped with the episodic memory id, not a source entry id.
			const claimRow = db
				.prepare(
					`SELECT id, source_id, source_kind FROM entity_attributes
					 WHERE agent_id = ? AND content LIKE ?`,
				)
				.get(AGENT, "%integrates Atlas%") as
				| { id: string; source_id: string | null; source_kind: string | null }
				| undefined;
			expect(claimRow).toBeDefined();
			expect(claimRow!.source_id).toBe("mem-user-owned");
			expect(claimRow!.source_kind).toBe("manual");

			// Source-disconnect purge by a configured source entry id does NOT
			// remove the derived claim because user-owned explicit memory has no
			// configured source entry id to match. This is intentional: the
			// semantic state derived from explicit user memory is user-owned and
			// survives a source disconnect.
			const purgedAttrs = db
				.prepare("DELETE FROM entity_attributes WHERE agent_id = ? AND source_id = ?")
				.run(AGENT, "obsidian:user-owned").changes;
			expect(purgedAttrs).toBe(0);
			expect(
				(
					db.prepare("SELECT COUNT(*) AS n FROM entity_attributes WHERE id = ?").get(claimRow!.id) as {
						n: number;
					}
				).n,
			).toBe(1);

			// Purging by the episodic memory id itself is a user-memory delete, not a
			// source-disconnect purge, and is out of scope for the Dreaming path.
			// The claim remains attached to the explicit memory provenance.
		});

		it("advances evidence after discarding an invalid operation", async () => {
			const evidence = "Atlas is the active research project.";
			seedSummary(db, "invalid-operation", evidence, 6);
			const result = await runDreamingPass(
				accessor,
				async () =>
					JSON.stringify({
						operations: [
							{ operation: "invent_operation", payload: {}, reason: "Not supported", evidence: [] },
							{
								operation: "create_entity",
								payload: { name: "Atlas", entity_type: "project" },
								reason: "The summary identifies a durable project.",
								evidence: [{ source_kind: "summary", source_id: "invalid-operation", quote: evidence }],
							},
						],
						summary: "Created Atlas and discarded invalid output",
					}),
				defaultCfg(),
				"/tmp",
				AGENT,
				"incremental",
			);
			expect(result).toMatchObject({ applied: 1, failed: 1 });
			expect(getDreamingState(accessor, AGENT).evidenceCursor?.id).toBe("invalid-operation");
		});

		it("keeps valid semantic operations when a later operation is rejected", async () => {
			const evidence = "Cedar is an active project with a deprecated entity to archive.";
			seedSummary(db, "rejected-operation", evidence, 9);
			const result = await runDreamingPass(
				accessor,
				async () =>
					JSON.stringify({
						operations: [
							{
								operation: "create_entity",
								payload: { name: "Cedar", entity_type: "project" },
								reason: "The summary identifies a durable project.",
								evidence: [{ source_kind: "summary", source_id: "rejected-operation", quote: evidence }],
							},
							{
								operation: "archive_entity",
								payload: { selector: "entity-that-does-not-exist" },
								reason: "This intentionally verifies isolated operation rejection.",
								evidence: [{ source_kind: "summary", source_id: "rejected-operation", quote: evidence }],
							},
						],
						summary: "Created Cedar; rejected the nonexistent archive",
					}),
				defaultCfg(),
				"/tmp",
				AGENT,
				"incremental",
			);
			expect(result).toMatchObject({ applied: 1, failed: 1 });
			expect(
				db.prepare("SELECT name FROM entities WHERE agent_id = ? AND canonical_name = 'cedar'").get(AGENT),
			).toEqual({ name: "Cedar" });
			expect(getDreamingState(accessor, AGENT).evidenceCursor?.id).toBe("rejected-operation");
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

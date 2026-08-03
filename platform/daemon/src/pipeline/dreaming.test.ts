import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { DreamingConfig } from "@signet/core";
import { runMigrations } from "../../../core/src/migrations";
import type { DbAccessor } from "../db-accessor";
import {
	_testParseEpisodicCursor,
	getDreamingEvidenceExclusions,
	getDreamingPasses,
	getDreamingState,
	recordDreamingFailure,
	runDreamingAgentPass,
	shouldTriggerDreaming,
} from "./dreaming";

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
			} catch (error) {
				db.exec("ROLLBACK");
				throw error;
			}
		},
	} as unknown as DbAccessor;
}

function seedSummary(db: Database, id: string, content: string, tokens: number): void {
	db.prepare(
		`INSERT INTO session_summaries
		 (id, agent_id, content, token_count, depth, kind, source_type, earliest_at, latest_at, created_at)
		 VALUES (?, ?, ?, ?, 0, 'session', 'summary', datetime('now'), datetime('now'), datetime('now'))`,
	).run(id, AGENT, content, tokens);
}

describe("Dreaming", () => {
	let db: Database;
	let accessor: DbAccessor;

	beforeEach(() => {
		db = new Database(":memory:");
		runMigrations(db as unknown as Parameters<typeof runMigrations>[0]);
		accessor = wrapDb(db);
	});

	afterEach(() => db.close());

	it("round-trips only canonical episodic cursor kinds", () => {
		for (const kind of ["memory", "artifact", "transcript", "summary"] as const) {
			const cursor = { capturedAt: "2026-03-01T00:00:00.000Z", kind, id: `id-${kind}` };
			expect(_testParseEpisodicCursor(JSON.stringify(cursor))).toEqual(cursor);
		}
		expect(_testParseEpisodicCursor(JSON.stringify({ capturedAt: "2026-01-01", kind: "unknown", id: "x" }))).toBeNull();
	});

	it("uses wall-clock backoff independently of later evidence volume", () => {
		seedSummary(db, "first", "episodic source", 10);
		recordDreamingFailure(accessor, AGENT);
		const failedAt = Date.parse(getDreamingState(accessor, AGENT).lastFailureAt ?? "");
		const cfg = defaultCfg({ tokenThreshold: 1, backfillOnFirstRun: false });
		expect(shouldTriggerDreaming(accessor, cfg, AGENT, failedAt + 10 * 60 * 1000 - 1)).toBe(false);
		seedSummary(db, "later", "episodic source ".repeat(3_000), 3_000);
		expect(shouldTriggerDreaming(accessor, cfg, AGENT, failedAt + 10 * 60 * 1000)).toBe(true);
	});

	it("applies cited operations only through the daemon-owned tool surface", async () => {
		const evidence = "Aster is the project that owns the edge deployment.";
		seedSummary(db, "agentic-summary", evidence, 12);
		const result = await runDreamingAgentPass(
			accessor,
			{
				async run(input) {
					const apply = input.tools.find((tool) => tool.name === "apply_ontology_ops");
					if (!apply) throw new Error("Missing apply_ontology_ops");
					await apply.execute(
						"call",
						{
							operations: [
								{
									operation: "create_entity",
									payload: { name: "Aster", entity_type: "project" },
									reason: "The evidence names a durable project.",
									evidence: [
										{
											source_ref: "summary:agentic-summary",
											source_kind: "summary",
											source_id: "agentic-summary",
											quote: evidence,
										},
									],
								},
							],
						},
						undefined,
						undefined,
						{} as never,
					);
					return { summary: "Created Aster" };
				},
			},
			defaultCfg(),
			"/tmp",
			AGENT,
			"incremental",
		);
		expect(result).toMatchObject({ applied: 1, failed: 0, summary: "Created Aster" });
		expect(db.prepare("SELECT proposal_id FROM entities WHERE agent_id = ? AND name = 'Aster'").get(AGENT)).toMatchObject({
			proposal_id: expect.any(String),
		});
	});

	it("retains rejected agent evidence for explicit requeue", async () => {
		const evidence = "Briar owns the release process.";
		seedSummary(db, "rejected-summary", evidence, 8);
		const result = await runDreamingAgentPass(
			accessor,
			{
				async run(input) {
					const apply = input.tools.find((tool) => tool.name === "apply_ontology_ops");
					if (!apply) throw new Error("Missing apply_ontology_ops");
					await apply.execute(
						"call",
						{
							operations: [
								{
									operation: "not_an_ontology_operation",
									payload: {},
									evidence: [
										{
											source_ref: "summary:rejected-summary",
											source_kind: "summary",
											source_id: "rejected-summary",
											quote: evidence,
										},
									],
								},
							],
						},
						undefined,
						undefined,
						{} as never,
					);
					return { summary: "Rejected unsupported operation" };
				},
			},
			defaultCfg(),
			"/tmp",
			AGENT,
			"incremental",
		);
		expect(result).toMatchObject({ applied: 0, failed: 1 });
		expect(getDreamingEvidenceExclusions(accessor, AGENT)).toContainEqual(
			expect.objectContaining({ sourceKind: "summary", sourceId: "rejected-summary", reason: "semantic_operation_rejected" }),
		);
	});

	it("records empty and failed bounded-agent passes honestly", async () => {
		let invoked = false;
		const empty = await runDreamingAgentPass(
			accessor,
			{ async run() { invoked = true; return { summary: "unexpected" }; } },
			defaultCfg(),
			"/tmp",
			AGENT,
			"incremental",
		);
		expect(empty.summary).toBe("No new episodic evidence or semantic entities to process");
		expect(invoked).toBe(false);

		seedSummary(db, "failure", "Evidence that reaches the agent.", 5);
		await expect(
			runDreamingAgentPass(
				accessor,
				{ async run() { throw new Error("agent timeout"); } },
				defaultCfg(),
				"/tmp",
				AGENT,
				"incremental",
			),
		).rejects.toThrow("agent timeout");
		expect(getDreamingPasses(accessor, AGENT).find((pass) => pass.status === "failed")?.error).toBe("agent timeout");
	});
});

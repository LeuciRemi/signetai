import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDbAccessor, getDbAccessor, initDbAccessor } from "../db-accessor";
import { applyDreamingOperations } from "./dreaming-operations";

describe("dreaming operations", () => {
	let dir = "";

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "signet-dreaming-operations-"));
		mkdirSync(join(dir, "memory"), { recursive: true });
		initDbAccessor(join(dir, "memory", "memories.db"));
		getDbAccessor().withWriteTx((db) => {
			db.prepare(
				`INSERT INTO session_summaries
				 (id, agent_id, content, token_count, depth, kind, source_type, earliest_at, latest_at, created_at)
				 VALUES ('summary-1', 'agent-a', 'Atlas runs the deployment workflow.', 8, 0, 'session', 'summary', datetime('now'), datetime('now'), datetime('now'))`,
			).run();
		});
	});

	afterEach(() => {
		closeDbAccessor();
		rmSync(dir, { recursive: true, force: true });
	});

	it("resolves a scoped canonical citation without a Pi session", () => {
		const result = applyDreamingOperations({
			accessor: getDbAccessor(),
			agentId: "agent-a",
			actor: "acpx",
			operations: [
				{
					operation: "create_entity",
					payload: { name: "Atlas", entity_type: "project" },
					reason: "The summary names the project.",
					evidence: [
						{
							source_ref: "summary:summary-1",
							source_kind: "summary",
							source_id: "summary-1",
							quote: "Atlas runs the deployment workflow.",
						},
					],
				},
			],
		});
		expect(result.ok).toBe(true);
		expect(
			getDbAccessor()
				.withReadDb((db) => db.prepare("SELECT source_id FROM ontology_proposals WHERE agent_id = 'agent-a'").get()),
		).toMatchObject({ source_id: "summary-1" });
	});

	it("rejects a citation outside the caller's agent scope", () => {
		const result = applyDreamingOperations({
			accessor: getDbAccessor(),
			agentId: "agent-b",
			actor: "acpx",
			operations: [
				{
					operation: "create_entity",
					payload: { name: "Atlas" },
					evidence: [
						{
							source_ref: "summary:summary-1",
							source_kind: "summary",
							source_id: "summary-1",
							quote: "Atlas runs the deployment workflow.",
						},
					],
				},
			],
		});
		expect(result).toMatchObject({ ok: false, error: "Every operation must cite an exact quote from scoped episodic evidence" });
	});

	it("does not replace an existing entity's provenance with later cited evidence", () => {
		getDbAccessor().withWriteTx((db) => {
			db.prepare(
				`INSERT INTO entities
				 (id, name, canonical_name, entity_type, agent_id, mentions, source_id, source_root, created_at, updated_at)
				 VALUES ('atlas-existing', 'Atlas', 'atlas', 'project', 'agent-a', 1, 'user:manual', 'user', datetime('now'), datetime('now'))`,
			).run();
		});
		const result = applyDreamingOperations({
			accessor: getDbAccessor(),
			agentId: "agent-a",
			actor: "dreaming",
			operations: [
				{
					operation: "create_entity",
					payload: { name: "Atlas", entity_type: "project" },
					evidence: [
						{
							source_ref: "summary:summary-1",
							source_kind: "summary",
							source_id: "summary-1",
							quote: "Atlas runs the deployment workflow.",
						},
					],
				},
			],
		});
		expect(result.ok).toBe(true);
		expect(
			getDbAccessor().withReadDb(
				(db) => db.prepare("SELECT source_id, source_root FROM entities WHERE id = 'atlas-existing'").get(),
			),
		).toEqual({ source_id: "user:manual", source_root: "user" });
	});
});

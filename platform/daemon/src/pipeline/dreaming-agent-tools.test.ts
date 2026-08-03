import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDbAccessor, getDbAccessor, initDbAccessor } from "../db-accessor";
import {
	createDreamingAgentTools,
} from "./dreaming-agent-tools";
import type { DreamingAgentEvidence } from "./dreaming-evidence";

/**
 * Regression coverage for the daemon-owned conceptual ontology tool factory
 * (#946). These tests pin four contracts:
 *  - agent isolation: tools scoped to one agentId cannot see another agent's graph
 *  - citation rejection: quotes that are not exact substrings of supplied evidence are rejected
 *  - per-op isolation: one failing op rolls back only itself inside the caller-owned tx
 *
 * No assertions are made about new feature quality — these pin the named
 * agent-isolation, vocabulary, citation, and transactional invariants.
 */
describe("dreaming-agent-tools", () => {
	let dir = "";

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "signet-dreaming-agent-tools-"));
		mkdirSync(join(dir, "memory"), { recursive: true });
		initDbAccessor(join(dir, "memory", "memories.db"));
	});

	afterEach(() => {
		closeDbAccessor();
		rmSync(dir, { recursive: true, force: true });
	});

	function insertEntity(id: string, name: string, canonicalName: string, agentId: string): void {
		getDbAccessor().withWriteTx((db) => {
			db.prepare(
				`INSERT INTO entities
				 (id, name, canonical_name, entity_type, agent_id, mentions, pinned, created_at, updated_at)
				 VALUES (?, ?, ?, 'project', ?, 1, 0, '2026-05-06T00:00:00.000Z', '2026-05-06T00:00:00.000Z')`,
			).run(id, name, canonicalName, agentId);
		});
	}

	const EVIDENCE_CONTENT = "Acme switched its deployment target to edge runtime in Q2.";
	const CITATION = {
		source_ref: "transcript:acme-q2",
		source_kind: "transcript",
		source_id: "acme-q2",
		quote: EVIDENCE_CONTENT,
	};
	const evidence: readonly DreamingAgentEvidence[] = [
		{
			sourceRef: "transcript:acme-q2",
			content: EVIDENCE_CONTENT,
			sourceKind: "transcript",
			sourceId: "acme-q2",
			sourcePath: null,
			sourceEntryId: null,
		},
	];

	function readResult(res: { readonly content: ReadonlyArray<{ readonly text: string }> }): {
		readonly tool: string;
		readonly ok: boolean;
		readonly [key: string]: unknown;
	} {
		return JSON.parse(res.content[0]!.text);
	}

	function findTool(tools: readonly ReturnType<typeof createDreamingAgentTools>, name: string) {
		const tool = tools.find((t) => t.name === name);
		if (!tool) throw new Error(`tool ${name} not registered`);
		return tool;
	}

	it("isolates reads by agentId: search_entities only returns the caller's entities", async () => {
		insertEntity("e-owner", "Owner Entity", "owner entity", "owner");
		insertEntity("e-other", "Other Entity", "other entity", "intruder");

		const tools = createDreamingAgentTools({ accessor: getDbAccessor(), agentId: "owner", actor: "owner" });
		const search = findTool(tools, "search_entities");
		const res = readResult(await search.execute("call", { query: "entity" }, undefined, undefined, {} as never));
		expect(res.ok).toBe(true);
		const items = res.items as Array<{ id: string; name: string }>;
		expect(items.map((i) => i.id)).toEqual(["e-owner"]);
		expect(items.some((i) => i.id === "e-other")).toBe(false);
	});

	it("get_entity returns null result for an entity owned by another agent", async () => {
		insertEntity("e-other", "Other Entity", "other entity", "intruder");

		const tools = createDreamingAgentTools({ accessor: getDbAccessor(), agentId: "owner", actor: "owner" });
		const getEntity = findTool(tools, "get_entity");
		const res = readResult(await getEntity.execute("call", { entityId: "e-other" }, undefined, undefined, {} as never));
		expect(res.ok).toBe(false);
		expect(res.error).toBe("Entity not found");
	});

	it("rejects an unsupported operation before touching the graph", async () => {
		const tools = createDreamingAgentTools({
			accessor: getDbAccessor(),
			agentId: "ant",
			actor: "ant",
			evidence,
		});
		const apply = findTool(tools, "apply_ontology_ops");
		const res = readResult(
			await apply.execute(
				"call",
				{
					operations: [
						{
							operation: "drop_everything",
							payload: {},
							reason: "malicious",
							evidence: [CITATION],
						},
					],
				},
				undefined,
				undefined,
				{} as never,
			),
		);
		expect(res.ok).toBe(false);
		expect(res.error).toContain("Unsupported ontology proposal operation");
	});

	it("rejects citations whose quote is not an exact substring of supplied evidence", async () => {
		const tools = createDreamingAgentTools({
			accessor: getDbAccessor(),
			agentId: "ant",
			actor: "ant",
			evidence,
		});
		const apply = findTool(tools, "apply_ontology_ops");
		const res = readResult(
			await apply.execute(
				"call",
				{
					operations: [
						{
							operation: "create_entity",
							payload: { name: "Fabricated" },
							reason: "hallucinated evidence",
							evidence: [{ ...CITATION, quote: "This quote was never shown to the agent." }],
						},
					],
				},
				undefined,
				undefined,
				{} as never,
			),
		);
		expect(res.ok).toBe(false);
		expect(res.error).toContain("exact quote");
	});

	it("rejects operations when no evidence is supplied to the session", async () => {
		const tools = createDreamingAgentTools({
			accessor: getDbAccessor(),
			agentId: "ant",
			actor: "ant",
			// no evidence array
		});
		const apply = findTool(tools, "apply_ontology_ops");
		const res = readResult(
			await apply.execute(
				"call",
				{
					operations: [
						{
							operation: "create_entity",
							payload: { name: "No Evidence" },
							reason: "none",
							evidence: [CITATION],
						},
					],
				},
				undefined,
				undefined,
				{} as never,
			),
		);
		expect(res.ok).toBe(false);
	});

	it("provides per-op isolation: one failing op rolls back only itself while valid ops apply", async () => {
		// Regression: per-op SAVEPOINT isolation. The second op targets a
		// missing entity and must fail, but the first (create_entity) and
		// third (another create_entity) must still commit inside the same
		// caller-owned transaction.
		const tools = createDreamingAgentTools({
			accessor: getDbAccessor(),
			agentId: "ant",
			actor: "ant",
			evidence,
		});
		const apply = findTool(tools, "apply_ontology_ops");

		const res = readResult(
			await apply.execute(
				"call",
				{
					operations: [
						{
							operation: "create_entity",
							payload: { name: "First Entity", entity_type: "project" },
							reason: "valid first op",
							evidence: [CITATION],
						},
						{
							// update_link against a non-existent dependency id throws
							// "Link not found" (404), exercising per-op rollback.
							operation: "update_link",
							payload: { id: "link-does-not-exist", link_type: "related_to", reason: "missing" },
							reason: "will fail",
							evidence: [CITATION],
						},
						{
							operation: "create_entity",
							payload: { name: "Third Entity", entity_type: "project" },
							reason: "valid third op",
							evidence: [CITATION],
						},
					],
				},
				undefined,
				undefined,
				{} as never,
			),
		);

		expect(res.ok).toBe(true);
		const items = res.items as Array<{ index: number; ok: boolean; error?: string }>;
		expect(items).toHaveLength(3);
		expect(items[0]!.ok).toBe(true);
		expect(items[1]!.ok).toBe(false);
		expect(typeof items[1]!.error).toBe("string");
		expect(items[2]!.ok).toBe(true);

		// The valid ops committed despite the middle failure.
		const names = getDbAccessor().withReadDb((db) =>
			db
				.prepare("SELECT name FROM entities WHERE agent_id = ? ORDER BY name ASC")
				.all("ant") as Array<{ name: string }>,
		);
		const nameSet = new Set(names.map((n) => n.name));
		expect(nameSet.has("First Entity")).toBe(true);
		expect(nameSet.has("Third Entity")).toBe(true);
	});

	it("returns JSON tool results and does not truncate create_entity output", async () => {
		const tools = createDreamingAgentTools({
			accessor: getDbAccessor(),
			agentId: "ant",
			actor: "ant",
			evidence,
		});
		const apply = findTool(tools, "apply_ontology_ops");
		const res = await apply.execute(
			"call",
			{
				operations: [
					{
						operation: "create_entity",
						payload: { name: "Full Output Entity", entity_type: "project" },
						reason: "verify full JSON result",
						evidence: [CITATION],
					},
				],
			},
			undefined,
			undefined,
			{} as never,
		);
		// Result must be a single JSON text content block (no truncation markers).
		expect(res.content).toHaveLength(1);
		expect(res.content[0]!.type).toBe("text");
		const parsed = JSON.parse(res.content[0]!.text);
		expect(parsed.tool).toBe("apply_ontology_ops");
		expect(parsed.ok).toBe(true);
		expect(parsed.items[0].result.entityId).toBeDefined();
	});
});

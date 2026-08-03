/**
 * Dreaming agent — periodic smart-model consolidation of the knowledge graph.
 *
 * Reads accumulated session summaries and the current entity graph,
 * produces structured graph mutations (create, merge, update, delete,
 * supersede), and applies them transactionally.
 *
 * See docs/specs/approved/dreaming-memory-consolidation.md
 */

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	type DreamingConfig,
	type IdentityContextFileEntry,
	resolveSpecialIdentityFiles,
	resolveStartupIdentityFiles,
} from "@signet/core";
import type { DbAccessor, ReadDb, WriteDb } from "../db-accessor";
import {
	type EpisodicCursor,
	type EpisodicSourceRecord,
	readEpisodicSource,
	readRecentEpisodicSources,
} from "../episodic-sources";
import { logger } from "../logger";
import { createDreamingAgentTools } from "./dreaming-agent-tools";
import type { DreamingToolCallTrace } from "./dreaming-capabilities";
import {
	createDreamingAgentEvidence,
	nextDreamingEvidenceFragment,
	renderDreamingEvidence,
	type DreamingEvidenceFragment,
} from "./dreaming-evidence";
import type { ApplyDreamingOperationsResult, DreamingOperationRequest } from "./dreaming-operations";
import { countTokens } from "./tokenizer";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DreamingMode = "incremental" | "compact";

export interface DreamingState {
	readonly consecutiveFailures: number;
	readonly lastFailureAt: string | null;
	readonly lastPassAt: string | null;
	readonly evidenceCursor: EpisodicCursor | null;
	readonly lastPassId: string | null;
	readonly lastPassMode: string | null;
}

function parseEpisodicCursor(value: string | null): EpisodicCursor | null {
	if (!value) return null;
	try {
		const parsed = JSON.parse(value) as { capturedAt?: unknown; kind?: unknown; id?: unknown; fragmentOffset?: unknown };
		if (typeof parsed.capturedAt !== "string" || typeof parsed.id !== "string") return null;
		if (
			parsed.kind !== null &&
			parsed.kind !== "memory" &&
			parsed.kind !== "artifact" &&
			parsed.kind !== "transcript" &&
			parsed.kind !== "summary"
		) {
			return null;
		}
		const fragmentOffset =
			typeof parsed.fragmentOffset === "number" &&
			Number.isSafeInteger(parsed.fragmentOffset) &&
			parsed.fragmentOffset > 0
				? parsed.fragmentOffset
				: undefined;
		return { capturedAt: parsed.capturedAt, kind: parsed.kind ?? null, id: parsed.id, ...(fragmentOffset ? { fragmentOffset } : {}) };
	} catch {
		return null;
	}
}

/** Exported for cursor round-trip tests. */
export function _testParseEpisodicCursor(value: string | null): EpisodicCursor | null {
	return parseEpisodicCursor(value);
}

interface DreamingPassRow {
	readonly id: string;
	readonly mode: string;
	readonly status: string;
	readonly startedAt: string;
	readonly completedAt: string | null;
	readonly tokensConsumed: number | null;
	readonly mutationsApplied: number | null;
	readonly mutationsSkipped: number | null;
	readonly mutationsFailed: number | null;
	readonly summary: string | null;
	readonly error: string | null;
}

export interface DreamingToolCall {
	readonly id: string;
	readonly passId: string;
	readonly sequence: number;
	readonly toolCallId: string | null;
	readonly toolName: string;
	readonly input: unknown;
	readonly output: unknown;
	readonly success: boolean;
	readonly latencyMs: number;
	readonly createdAt: string;
}

export interface DreamingEvidenceExclusion {
	readonly sourceKind: EpisodicSourceRecord["kind"];
	readonly sourceId: string;
	readonly reason: string;
	readonly passId: string;
	readonly excludedAt: string;
	readonly requeueRequestedAt: string | null;
	readonly resolvedAt: string | null;
}

interface EntityRow {
	readonly id: string;
	readonly name: string;
	readonly entityType: string;
	readonly description: string | null;
}

interface AspectRow {
	readonly id: string;
	readonly entityId: string;
	readonly name: string;
	readonly weight: number;
}

interface AttributeRow {
	readonly id: string;
	readonly aspectId: string;
	readonly kind: string;
	readonly content: string;
	readonly status: string;
	readonly importance: number;
}

interface DependencyRow {
	readonly id: string;
	readonly sourceEntityId: string;
	readonly targetEntityId: string;
	readonly dependencyType: string;
	readonly strength: number;
	readonly confidence: number;
	readonly reason: string | null;
}

/** Source-native navigation rows are episodic topology, not semantic memory. */
function semanticEntityFilter(alias = ""): string {
	const column = (name: "entity_type" | "source_root"): string => (alias ? `${alias}.${name}` : name);
	return `NOT (
		${column("entity_type")} IN ('source_document', 'source_folder', 'source_document_reference', 'skill')
		OR (${column("entity_type")} = 'source' AND ${column("source_root")} IS NOT NULL)
	)`;
}

/** Routed bounded-agent executor. The daemon creates the tools and owns all writes. */
export interface DreamingAgentExecutor {
	run(input: {
		readonly prompt: string;
		readonly tools: ReturnType<typeof createDreamingAgentTools>;
		readonly timeoutMs: number;
		readonly maxTokens: number;
	}): Promise<{ readonly summary?: string }>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readNonEmptyString(value: unknown): string | null {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/**
 * Keep evidence cited by an agent operation that the daemon rejects. The
 * agentic calls preserve this audit/requeue trail even when citation
 * validation fails before the operation service can return per-item results.
 */
function rejectedAgentEvidence(
	result: ApplyDreamingOperationsResult,
	operations: readonly DreamingOperationRequest[],
	sources: readonly EpisodicSourceRecord[],
): readonly EpisodicSourceRecord[] {
	const rejectedIndexes = new Set<number>(
		result.items.filter((item) => !item.ok).map((item) => item.index),
	);
	const rejectedOperations =
		rejectedIndexes.size > 0
			? operations.filter((_operation, index) => rejectedIndexes.has(index))
			: result.ok
				? []
				: operations;
	const references = new Set<string>();
	for (const operation of rejectedOperations) {
		for (const evidence of operation.evidence ?? []) {
			if (!isRecord(evidence)) continue;
			const sourceRef = readNonEmptyString(evidence.source_ref);
			if (sourceRef) references.add(sourceRef);
		}
	}
	return sources.filter((source) => references.has(`${source.kind}:${source.id}`));
}

// ---------------------------------------------------------------------------
// Dreaming state DB helpers
// ---------------------------------------------------------------------------

function readDreamingState(db: ReadDb, agentId: string): DreamingState {
	let row:
		| {
				consecutive_failures: number;
				last_failure_at: string | null;
				last_pass_at: string | null;
				evidence_cursor: string | null;
				last_pass_id: string | null;
				last_pass_mode: string | null;
		  }
		| undefined;
	try {
		row = db
			.prepare(
				`SELECT consecutive_failures, last_failure_at,
				        last_pass_at, evidence_cursor, last_pass_id, last_pass_mode
				 FROM dreaming_state WHERE agent_id = ?`,
			)
			.get(agentId) as typeof row;
	} catch {
		// The constellation can be read while an old workspace migrates.
		row = undefined;
	}
	if (!row) {
		return {
			consecutiveFailures: 0,
			lastFailureAt: null,
			lastPassAt: null,
			evidenceCursor: null,
			lastPassId: null,
			lastPassMode: null,
		};
	}
	return {
		consecutiveFailures: row.consecutive_failures,
		lastFailureAt: row.last_failure_at,
		lastPassAt: row.last_pass_at,
		evidenceCursor: parseEpisodicCursor(row.evidence_cursor),
		lastPassId: row.last_pass_id,
		lastPassMode: row.last_pass_mode,
	};
}

export function getDreamingState(accessor: DbAccessor, agentId: string): DreamingState {
	return accessor.withReadDb((db) => readDreamingState(db, agentId));
}

function resetDreamingTokens(
	db: WriteDb,
	agentId: string,
	passId: string,
	mode: string,
	evidenceCursor: EpisodicCursor | null,
	lastPassAt: string | null,
): void {
	const exists = db.prepare("SELECT 1 FROM dreaming_state WHERE agent_id = ?").get(agentId);
	if (exists) {
		db.prepare(
			`UPDATE dreaming_state
			 SET consecutive_failures = 0,
			     last_failure_at = NULL,
			     last_pass_at = ?,
			     evidence_cursor = ?,
			     last_pass_id = ?,
			     last_pass_mode = ?,
			     updated_at = datetime('now')
			 WHERE agent_id = ?`,
		).run(lastPassAt, evidenceCursor === null ? null : JSON.stringify(evidenceCursor), passId, mode, agentId);
	} else {
		db.prepare(
			`INSERT INTO dreaming_state
			 (agent_id, consecutive_failures, last_failure_at, last_pass_at, evidence_cursor, last_pass_id, last_pass_mode)
			 VALUES (?, 0, NULL, ?, ?, ?, ?)`,
		).run(agentId, lastPassAt, evidenceCursor === null ? null : JSON.stringify(evidenceCursor), passId, mode);
	}
}

export function recordDreamingFailure(accessor: DbAccessor, agentId: string): void {
	accessor.withWriteTx((db) => {
		const exists = db.prepare("SELECT 1 FROM dreaming_state WHERE agent_id = ?").get(agentId);
		if (exists) {
			db.prepare(
				`UPDATE dreaming_state
				 SET consecutive_failures = consecutive_failures + 1,
				     last_failure_at = datetime('now'),
				     updated_at = datetime('now')
				 WHERE agent_id = ?`,
			).run(agentId);
		} else {
			db.prepare(
				`INSERT INTO dreaming_state (agent_id, tokens_since_last_pass, consecutive_failures, last_failure_at)
				 VALUES (?, 0, 1, datetime('now'))`,
			).run(agentId);
		}
	});
}

// ---------------------------------------------------------------------------
// Dreaming pass records
// ---------------------------------------------------------------------------

export function createDreamingPass(accessor: DbAccessor, agentId: string, mode: DreamingMode): string {
	const id = randomUUID();
	accessor.withWriteTx((db) => {
		db.prepare(
			`INSERT INTO dreaming_passes (id, agent_id, mode, status, started_at, created_at)
			 VALUES (?, ?, ?, 'running', datetime('now'), datetime('now'))`,
		).run(id, agentId, mode);
	});
	return id;
}

function failDreamingPass(accessor: DbAccessor, passId: string, error: string): void {
	accessor.withWriteTx((db) => {
		db.prepare(
			`UPDATE dreaming_passes
			 SET status = 'failed',
			     completed_at = datetime('now'),
			     error = ?
			 WHERE id = ?`,
		).run(error, passId);
	});
}

export function getDreamingPasses(accessor: DbAccessor, agentId: string, limit = 10): readonly DreamingPassRow[] {
	return accessor.withReadDb((db) => {
		return db
			.prepare(
				`SELECT id, mode, status, started_at AS startedAt,
				        completed_at AS completedAt, tokens_consumed AS tokensConsumed,
				        mutations_applied AS mutationsApplied,
				        mutations_skipped AS mutationsSkipped,
				        mutations_failed AS mutationsFailed,
				        summary, error
				 FROM dreaming_passes
				 WHERE agent_id = ?
				 ORDER BY created_at DESC
				 LIMIT ?`,
			)
			.all(agentId, limit) as DreamingPassRow[];
	});
}

const MAX_DREAMING_TOOL_TRACE_JSON_CHARS = 128_000;

function serializeToolTrace(value: unknown): string {
	let json: string | undefined;
	try {
		json = JSON.stringify(value);
	} catch (error) {
		return JSON.stringify({ serializationError: error instanceof Error ? error.message : String(error) });
	}
	if (json === undefined) return "null";
	if (json.length <= MAX_DREAMING_TOOL_TRACE_JSON_CHARS) return json;
	return JSON.stringify({
		truncated: true,
		originalChars: json.length,
		preview: json.slice(0, MAX_DREAMING_TOOL_TRACE_JSON_CHARS),
	});
}

function parseToolTrace(value: string): unknown {
	try {
		return JSON.parse(value) as unknown;
	} catch {
		return { malformedTrace: true };
	}
}

function recordDreamingToolCall(
	accessor: DbAccessor,
	agentId: string,
	passId: string,
	sequence: number,
	trace: DreamingToolCallTrace,
): void {
	accessor.withWriteTx((db) => {
		db.prepare(
			`INSERT INTO dreaming_tool_calls
			 (id, agent_id, pass_id, sequence, tool_call_id, tool_name, input_json, output_json, success, latency_ms)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		).run(
			randomUUID(),
			agentId,
			passId,
			sequence,
			trace.toolCallId || null,
			trace.tool,
			serializeToolTrace(trace.input),
			serializeToolTrace(trace.output),
			trace.output.ok ? 1 : 0,
			Math.max(0, Math.floor(trace.latencyMs)),
		);
	});
}

/** Return the Pi capability trace for one scoped Dreaming pass. */
export function getDreamingToolCalls(accessor: DbAccessor, agentId: string, passId: string): readonly DreamingToolCall[] {
	return accessor.withReadDb((db) =>
		db
			.prepare(
				`SELECT id, pass_id AS passId, sequence, tool_call_id AS toolCallId,
				        tool_name AS toolName, input_json AS inputJson, output_json AS outputJson,
				        success, latency_ms AS latencyMs, created_at AS createdAt
				 FROM dreaming_tool_calls
				 WHERE agent_id = ? AND pass_id = ?
				 ORDER BY sequence ASC`,
			)
			.all(agentId, passId)
			.map((row) => {
				const typed = row as {
					id: string;
					passId: string;
					sequence: number;
					toolCallId: string | null;
					toolName: string;
					inputJson: string;
					outputJson: string;
					success: number;
					latencyMs: number;
					createdAt: string;
				};
				return {
					id: typed.id,
					passId: typed.passId,
					sequence: typed.sequence,
					toolCallId: typed.toolCallId,
					toolName: typed.toolName,
					input: parseToolTrace(typed.inputJson),
					output: parseToolTrace(typed.outputJson),
					success: typed.success === 1,
					latencyMs: typed.latencyMs,
					createdAt: typed.createdAt,
				};
			}) as DreamingToolCall[],
	);
}

export function getDreamingEvidenceExclusions(
	accessor: DbAccessor,
	agentId: string,
): readonly DreamingEvidenceExclusion[] {
	return accessor.withReadDb(
		(db) =>
			db
				.prepare(
					`SELECT source_kind AS sourceKind, source_id AS sourceId, reason,
				        pass_id AS passId, excluded_at AS excludedAt,
				        requeue_requested_at AS requeueRequestedAt, resolved_at AS resolvedAt
				 FROM dreaming_evidence_exclusions
				 WHERE agent_id = ? AND resolved_at IS NULL
				 ORDER BY excluded_at DESC, source_kind ASC, source_id ASC`,
				)
				.all(agentId) as DreamingEvidenceExclusion[],
	);
}

export function requestDreamingEvidenceRequeue(
	accessor: DbAccessor,
	agentId: string,
	sourceKind: EpisodicSourceRecord["kind"],
	sourceId: string,
): boolean {
	return accessor.withWriteTx((db) => {
		const result = db
			.prepare(
				`UPDATE dreaming_evidence_exclusions
				 SET requeue_requested_at = datetime('now')
				 WHERE agent_id = ? AND source_kind = ? AND source_id = ? AND resolved_at IS NULL`,
			)
			.run(agentId, sourceKind, sourceId) as { changes: number };
		return result.changes > 0;
	});
}

function recordDreamingEvidenceExclusionsInTx(
	db: WriteDb,
	agentId: string,
	passId: string,
	sources: readonly EpisodicSourceRecord[],
	reason: string,
): void {
	const statement = db.prepare(
		`INSERT INTO dreaming_evidence_exclusions
		 (agent_id, source_kind, source_id, reason, pass_id, excluded_at, requeue_requested_at, resolved_at)
			 VALUES (?, ?, ?, ?, ?, datetime('now'), NULL, NULL)
		 ON CONFLICT(agent_id, source_kind, source_id) DO UPDATE SET
		   reason = excluded.reason,
		   pass_id = excluded.pass_id,
		   excluded_at = excluded.excluded_at,
		   requeue_requested_at = NULL,
		   resolved_at = NULL`,
	);
	for (const source of sources) statement.run(agentId, source.kind, source.id, reason, passId);
}

function resolveRequeuedEvidenceInTx(db: WriteDb, agentId: string, sources: readonly EpisodicSourceRecord[]): void {
	const statement = db.prepare(
		`UPDATE dreaming_evidence_exclusions
		 SET resolved_at = datetime('now')
		 WHERE agent_id = ? AND source_kind = ? AND source_id = ?
		   AND requeue_requested_at IS NOT NULL AND resolved_at IS NULL`,
	);
	for (const source of sources) statement.run(agentId, source.kind, source.id);
}

// ---------------------------------------------------------------------------
// Data fetching for prompt assembly
// ---------------------------------------------------------------------------

function fetchEpisodicEvidence(
	db: ReadDb,
	agentId: string,
	since: string | null,
	limit: number,
	cursor: EpisodicCursor | null,
): readonly EpisodicSourceRecord[] {
	const sources = readRecentEpisodicSources(db, agentId, limit, undefined, since, "oldest", cursor);
	if (!cursor?.fragmentOffset || cursor.kind === null) return sources;
	const resumed = readEpisodicSource(db, { agentId, from: `${cursor.kind}:${cursor.id}` });
	if (!resumed) return sources;
	return [resumed, ...sources.filter((source) => source.kind !== resumed.kind || source.id !== resumed.id)].slice(0, limit);
}

function fetchEntityGraph(
	db: ReadDb,
	agentId: string,
	limits?: { entities?: number; aspects?: number; attributes?: number; dependencies?: number },
): {
	entities: readonly EntityRow[];
	aspects: readonly AspectRow[];
	attributes: readonly AttributeRow[];
	dependencies: readonly DependencyRow[];
} {
	const maxEntities = limits?.entities ?? 2000;
	const maxAspects = limits?.aspects ?? 10_000;
	const maxAttrs = limits?.attributes ?? 50_000;
	const maxDeps = limits?.dependencies ?? 10_000;

	const entities = db
		.prepare(
			`SELECT id, name, entity_type AS entityType, description
			 FROM entities WHERE agent_id = ? AND ${semanticEntityFilter()}
			 ORDER BY mentions DESC, updated_at DESC
			 LIMIT ?`,
		)
		.all(agentId, maxEntities) as EntityRow[];

	const aspects = db
		.prepare(
			`SELECT ea.id, ea.entity_id AS entityId, ea.name, ea.weight
			 FROM entity_aspects ea
			 JOIN entities e ON e.id = ea.entity_id AND e.agent_id = ea.agent_id
			 WHERE ea.agent_id = ? AND ${semanticEntityFilter("e")}
			 ORDER BY ea.weight DESC
			 LIMIT ?`,
		)
		.all(agentId, maxAspects) as AspectRow[];

	const attributes = db
		.prepare(
			`SELECT ea.id, ea.aspect_id AS aspectId, ea.kind, ea.content,
			        ea.status, ea.importance
			 FROM entity_attributes ea
			 JOIN entity_aspects asp ON asp.id = ea.aspect_id AND asp.agent_id = ea.agent_id
			 JOIN entities e ON e.id = asp.entity_id AND e.agent_id = ea.agent_id
			 WHERE ea.agent_id = ? AND ea.status = 'active' AND ${semanticEntityFilter("e")}
			 ORDER BY ea.importance DESC
			 LIMIT ?`,
		)
		.all(agentId, maxAttrs) as AttributeRow[];

	const dependencies = db
		.prepare(
			`SELECT entity_dependencies.id, entity_dependencies.source_entity_id AS sourceEntityId,
			        entity_dependencies.target_entity_id AS targetEntityId,
			        entity_dependencies.dependency_type AS dependencyType,
			        entity_dependencies.strength, entity_dependencies.confidence, entity_dependencies.reason
			 FROM entity_dependencies
			 JOIN entities source ON source.id = entity_dependencies.source_entity_id AND source.agent_id = entity_dependencies.agent_id
			 JOIN entities target ON target.id = entity_dependencies.target_entity_id AND target.agent_id = entity_dependencies.agent_id
			 WHERE entity_dependencies.agent_id = ?
			   AND ${semanticEntityFilter("source")}
			   AND ${semanticEntityFilter("target")}
			 ORDER BY entity_dependencies.strength DESC, entity_dependencies.confidence DESC,
			          entity_dependencies.updated_at DESC, entity_dependencies.id ASC
			 LIMIT ?`,
		)
		.all(agentId, maxDeps) as DependencyRow[];

	return { entities, aspects, attributes, dependencies };
}

/** Log when any graph query hit its row cap — signals incomplete data. */
function warnIfTruncated(
	graph: ReturnType<typeof fetchEntityGraph>,
	limits: { entities?: number; aspects?: number; attributes?: number; dependencies?: number },
): void {
	const truncated: string[] = [];
	if (graph.entities.length >= (limits.entities ?? 2000)) truncated.push(`entities(${graph.entities.length})`);
	if (graph.aspects.length >= (limits.aspects ?? 10_000)) truncated.push(`aspects(${graph.aspects.length})`);
	if (graph.attributes.length >= (limits.attributes ?? 50_000))
		truncated.push(`attributes(${graph.attributes.length})`);
	if (graph.dependencies.length >= (limits.dependencies ?? 10_000))
		truncated.push(`dependencies(${graph.dependencies.length})`);
	if (truncated.length > 0) {
		logger.warn("dreaming", "Entity graph truncated by row limits — dreaming pass will operate on a partial snapshot", {
			truncated,
		});
	}
}

// ---------------------------------------------------------------------------
// Prompt construction
// ---------------------------------------------------------------------------

function readIdentityFile(dir: string, entry: IdentityContextFileEntry): string {
	try {
		const raw = readFileSync(join(dir, entry.path), "utf-8").trim();
		if (!raw) return "";
		const budget = entry.budget ?? 4_000;
		return raw.length <= budget ? raw : `${raw.slice(0, budget)}\n[truncated]`;
	} catch (err) {
		logger.warn("dreaming", "Could not read identity file", { name: entry.path, error: String(err) });
		return "";
	}
}

function renderIdentityBlock(dir: string, entries: readonly IdentityContextFileEntry[]): string {
	return entries
		.map((entry) => {
			const content = readIdentityFile(dir, entry);
			return content ? `## ${entry.role ?? entry.path}\n\n${content}` : "";
		})
		.filter((s) => s.length > 0)
		.join("\n\n---\n\n");
}

function buildDreamingPrompt(
	mode: DreamingMode,
	evidence: readonly EpisodicSourceRecord[],
	graph: ReturnType<typeof fetchEntityGraph>,
	agentsDir: string,
	maxTokens: number,
	cursor: EpisodicCursor | null,
): {
	readonly prompt: string;
	readonly lastEvidence: EpisodicSourceRecord | null;
	readonly lastCursorEvidence: EpisodicSourceRecord | null;
	readonly lastCursorFragmentOffset: number | null;
	readonly renderedEvidence: readonly EpisodicSourceRecord[];
	readonly completedEvidence: readonly EpisodicSourceRecord[];
	readonly renderedFragments: readonly DreamingEvidenceFragment[];
} {
	const startupEntries = resolveStartupIdentityFiles(agentsDir);
	const startupMemoryEntry = startupEntries.find((entry) => entry.path.split(/[\\/]/).pop() === "MEMORY.md");
	const identity = renderIdentityBlock(
		agentsDir,
		startupEntries.filter((entry) => entry !== startupMemoryEntry),
	);
	const dreamingPrompt = renderIdentityBlock(agentsDir, resolveSpecialIdentityFiles(agentsDir, "dreaming"));
	const memoryMd = startupMemoryEntry ? readIdentityFile(agentsDir, startupMemoryEntry) : "";

	// Build graph snapshot
	const entityMap = new Map(graph.entities.map((e) => [e.id, e]));
	const aspectsByEntity = new Map<string, AspectRow[]>();
	for (const a of graph.aspects) {
		const list = aspectsByEntity.get(a.entityId) ?? [];
		list.push(a);
		aspectsByEntity.set(a.entityId, list);
	}
	const attrsByAspect = new Map<string, AttributeRow[]>();
	for (const a of graph.attributes) {
		const list = attrsByAspect.get(a.aspectId) ?? [];
		list.push(a);
		attrsByAspect.set(a.aspectId, list);
	}

	let graphText = "";
	// Character budget for graph section: ~20% of token budget (~4 chars/token)
	const graphBudget = Math.floor(maxTokens * 0.2 * 4);
	for (const entity of graph.entities) {
		const entityHeader = `\n## ${entity.name} (${entity.entityType})${entity.description ? `\n${entity.description}` : ""}`;
		if (graphText.length + entityHeader.length > graphBudget) break;
		graphText += entityHeader;
		const aspects = aspectsByEntity.get(entity.id) ?? [];
		for (const aspect of aspects) {
			const aspectLine = `\n### ${aspect.name} (weight: ${aspect.weight.toFixed(2)})`;
			if (graphText.length + aspectLine.length > graphBudget) break;
			graphText += aspectLine;
			const attrs = attrsByAspect.get(aspect.id) ?? [];
			for (const attr of attrs) {
				const tag = attr.kind === "constraint" ? " [CONSTRAINT]" : "";
				const attrLine = `\n- ${attr.content}${tag}`;
				if (graphText.length + attrLine.length > graphBudget) break;
				graphText += attrLine;
			}
		}
		graphText += "\n";
	}

	let depText = "";
	const depBudget = Math.floor(maxTokens * 0.03 * 4); // ~3% for dependencies
	for (const dep of graph.dependencies) {
		const src = entityMap.get(dep.sourceEntityId)?.name ?? dep.sourceEntityId;
		const tgt = entityMap.get(dep.targetEntityId)?.name ?? dep.targetEntityId;
		const line = `\n- ${src} --[${dep.dependencyType}]--> ${tgt} (strength: ${dep.strength.toFixed(2)}, confidence: ${dep.confidence.toFixed(2)})`;
		if (depText.length + line.length > depBudget) break;
		depText += line;
	}

	let evidenceText = "";
	// Keep substantial room for identity, instructions, and the structured result.
	const evidenceBudget = Math.floor(maxTokens * 0.4 * 4); // chars (~4 chars/token)
	let usedChars = 0;
	let lastEvidence: EpisodicSourceRecord | null = null;
	let lastCursorEvidence: EpisodicSourceRecord | null = null;
	let lastCursorFragmentOffset: number | null = null;
	const renderedEvidence: EpisodicSourceRecord[] = [];
	const completedEvidence: EpisodicSourceRecord[] = [];
	const renderedFragments: DreamingEvidenceFragment[] = [];
	for (const source of evidence) {
		const label = `${source.kind}:${source.sourceKind}`;
		// Surface project and harness provenance labels so the model can
		// reason about the originating context. These are display-only metadata
		// (the same provenance carried on EpisodicSourceRecord); they do not
		// gate reads, change citation matching (which keys on source_kind /
		// source_id / source_path / quote), or alter agent isolation.
		const provenanceSuffix = [source.project, source.harness].filter(Boolean).join(" · ");
		const heading = `\n### ${label} (${source.capturedAt})${provenanceSuffix ? ` — ${provenanceSuffix}` : ""}\nsource_ref: ${source.kind}:${source.id}\nsource_kind: ${source.sourceKind}\nsource_id: ${source.sourceId}\n${source.sourcePath ? `source_path: ${source.sourcePath}\n` : ""}`;
		// Use the canonical rendered source text (content + structured evidence)
		// for both budget accounting and prompt rendering so a source whose
		// structured metadata would overflow the budget is treated consistently
		// with its actual rendered size.
		const resumeOffset =
			cursor?.fragmentOffset && cursor.kind === source.kind && cursor.id === source.id ? cursor.fragmentOffset : 0;
		const fragment = nextDreamingEvidenceFragment(source, resumeOffset, evidenceBudget - usedChars - heading.length);
		if (!fragment) break;
		evidenceText += `${heading}${fragment.content}\n`;
		usedChars += heading.length + fragment.content.length;
		lastEvidence = source;
		lastCursorEvidence = source;
		lastCursorFragmentOffset = fragment.end < fragment.sourceLength ? fragment.end : null;
		renderedEvidence.push(source);
		renderedFragments.push(fragment);
		if (lastCursorFragmentOffset === null) completedEvidence.push(source);
		// A partial immutable record must resume before later records are read.
		if (lastCursorFragmentOffset !== null) break;
	}

	const modeInstructions =
		mode === "compact"
			? `You are running in COMPACTION mode. Focus on cleaning up the existing graph:
- Merge duplicate and near-duplicate entities (possessive forms, markdown artifacts, abbreviations of the same thing)
- Delete junk entities (fragments, markdown artifacts, truncated names)
- Prune meaningless or broken attributes
- Collapse redundant aspects
- Strengthen the graph structure by consolidating where possible`
			: `You are running in INCREMENTAL mode. Focus on integrating new session learnings:
- Create new entities for significant concepts, people, or projects mentioned in the sessions
- Update existing entity attributes with new information
- Merge any duplicates you notice
- Supersede outdated attributes with newer facts
- Delete attributes that are clearly wrong or outdated
- Add meaningful relationships between entities`;

	return {
		prompt: `<identity>
${identity}
</identity>

<working_memory>
${memoryMd}
</working_memory>

${dreamingPrompt ? `<dreaming_prompt>\n${dreamingPrompt}\n</dreaming_prompt>\n\n` : ""}<task>
You are taking time to reflect on ${mode === "compact" ? "your knowledge graph" : "recent episodic evidence"} and consolidate semantic memory.

${modeInstructions}

Guidelines:
- Constraints (attributes marked [CONSTRAINT]) are important decisions — do NOT delete them unless they are genuinely wrong
- Prefer merging over deleting when entities represent the same concept
- Keep entity names clean and consistent (no markdown formatting, no possessive forms as separate entities)
- When merging, pick the best canonical name as the target
- Provide clear reasons for all deletions and merges
- Be conservative — only change what you're confident about
- Episodic evidence is immutable source material. Do not treat it as semantic memory or rewrite it; use its provenance when deciding whether a semantic change is warranted.
</task>

${evidenceText ? `<episodic_evidence>\n${evidenceText}\n</episodic_evidence>` : ""}

<knowledge_graph>
${graphText}

### Entity Relationships
${depText || "(no relationships yet)"}
</knowledge_graph>

Use the supplied daemon tools to inspect semantic context before changing it. Search for entities before creating duplicates, inspect claim siblings before superseding them, and inspect links before updating them. Use apply_ontology_ops for every semantic write. Every operation must cite an exact quote plus source_ref from the episodic evidence you received or searched. Do not attempt direct database access.`,
		lastEvidence,
		lastCursorEvidence,
		lastCursorFragmentOffset,
		renderedEvidence,
		completedEvidence,
		renderedFragments,
	};
}

// ---------------------------------------------------------------------------
// Main dreaming orchestrator
// ---------------------------------------------------------------------------

/**
 * Bounded tool-loop Dreaming pass. The daemon owns evidence selection,
 * exclusion/cursor bookkeeping, tool construction, and audited writes.
 */
export async function runDreamingAgentPass(
	accessor: DbAccessor,
	executor: DreamingAgentExecutor,
	cfg: DreamingConfig,
	agentsDir: string,
	agentId: string,
	mode: DreamingMode,
	existingPassId?: string,
): Promise<{ passId: string; applied: number; skipped: number; failed: number; summary: string }> {
	const passId = existingPassId ?? createDreamingPass(accessor, agentId, mode);
	const passStartedAt = new Date().toISOString();
	try {
		const state = getDreamingState(accessor, agentId);
		const graphTokenBudget = Math.floor(cfg.maxInputTokens * 0.4);
		const graphLimits = {
			entities: Math.max(100, Math.floor(graphTokenBudget / 20)),
			aspects: Math.max(200, Math.floor(graphTokenBudget / 10)),
			attributes: Math.max(500, Math.floor(graphTokenBudget / 25)),
			dependencies: Math.max(200, Math.floor(graphTokenBudget / 20)),
		};
		const { evidence, graph } = accessor.withReadDb((db) => ({
			evidence: fetchEpisodicEvidence(
				db,
				agentId,
				mode === "compact" || state.evidenceCursor ? null : state.lastPassAt,
				200,
				state.evidenceCursor,
			),
			graph: fetchEntityGraph(db, agentId, graphLimits),
		}));
		warnIfTruncated(graph, graphLimits);
		if (mode === "incremental" && evidence.length === 0 && graph.entities.length === 0) {
			const summary = "No new episodic evidence or semantic entities to process";
			accessor.withWriteTx((db) => {
				db.prepare(
					`UPDATE dreaming_passes SET status = 'completed', completed_at = datetime('now'),
					 tokens_consumed = 0, mutations_applied = 0, mutations_skipped = 0,
					 mutations_failed = 0, summary = ? WHERE id = ?`,
				).run(summary, passId);
				resetDreamingTokens(db, agentId, passId, mode, state.evidenceCursor, state.lastPassAt);
			});
			return { passId, applied: 0, skipped: 0, failed: 0, summary };
		}

		const { prompt, lastCursorEvidence, lastCursorFragmentOffset, renderedEvidence, completedEvidence, renderedFragments } = buildDreamingPrompt(
			mode,
			evidence,
			graph,
			agentsDir,
			cfg.maxInputTokens,
			state.evidenceCursor,
		);
		const evidenceCursor: EpisodicCursor = lastCursorEvidence
			? {
					capturedAt: lastCursorEvidence.capturedAt,
					kind: lastCursorEvidence.kind,
					id: lastCursorEvidence.id,
					...(lastCursorFragmentOffset === null ? {} : { fragmentOffset: lastCursorFragmentOffset }),
				}
			: (state.evidenceCursor ?? { capturedAt: passStartedAt, kind: null, id: "" });

		let applied = 0;
		let failed = 0;
		let toolCallSequence = 0;
		const rejectedEvidence: EpisodicSourceRecord[] = [];
		const tools = createDreamingAgentTools({
			accessor,
			agentId,
			actor: "dreaming",
			evidence: createDreamingAgentEvidence(renderedFragments),
			onOperationsApplied(result, operations) {
				applied += result.items.filter((item) => item.ok).length;
				failed += result.items.filter((item) => !item.ok).length;
				if (!result.ok && result.items.length === 0) failed++;
				rejectedEvidence.push(...rejectedAgentEvidence(result, operations, renderedEvidence));
			},
			onToolCall(trace) {
				recordDreamingToolCall(accessor, agentId, passId, ++toolCallSequence, trace);
			},
		});
		logger.info("dreaming", "Starting agentic dreaming pass", {
			mode,
			episodicSources: evidence.length,
			promptChars: prompt.length,
		});
		const outcome = await executor.run({ prompt, tools, timeoutMs: cfg.timeout, maxTokens: cfg.maxOutputTokens });
		const summary = outcome.summary?.trim() || "Agentic Dreaming pass completed";
		const tokensConsumed = countTokens(prompt);
		accessor.withWriteTx((db) => {
			db.prepare(
				`UPDATE dreaming_passes SET status = 'completed', completed_at = datetime('now'),
				 tokens_consumed = ?, mutations_applied = ?, mutations_skipped = ?,
				 mutations_failed = ?, summary = ? WHERE id = ?`,
			).run(tokensConsumed, applied, 0, failed, summary, passId);
			recordDreamingEvidenceExclusionsInTx(db, agentId, passId, rejectedEvidence, "semantic_operation_rejected");
			resolveRequeuedEvidenceInTx(db, agentId, completedEvidence);
			resetDreamingTokens(db, agentId, passId, mode, evidenceCursor, passStartedAt);
		});
		return { passId, applied, skipped: 0, failed, summary };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		logger.error("dreaming", "Agentic dreaming pass failed", undefined, { error: message });
		failDreamingPass(accessor, passId, message);
		throw error;
	}
}

// ---------------------------------------------------------------------------
// Threshold check
// ---------------------------------------------------------------------------

// Max backoff: 5min * 2^6 = ~5.3 hours.
const MAX_FAILURE_BACKOFF_MULTIPLIER = 6;
const FAILURE_BACKOFF_BASE_MS = 5 * 60 * 1000;

/**
 * The worker's backlog is the episodic evidence it has not yet reasoned over,
 * not a separately maintained token counter. This keeps the trigger aligned
 * with every supported input source.
 */
export function getDreamingEpisodicTokenBacklog(accessor: DbAccessor, agentId: string): number {
	return accessor.withReadDb((db) => getDreamingEpisodicTokenBacklogInDb(db, agentId));
}

export function getDreamingEpisodicTokenBacklogInDb(db: ReadDb, agentId: string): number {
	const state = readDreamingState(db, agentId);
	const queued = readRecentEpisodicSources(
		db,
		agentId,
		500,
		undefined,
		state.evidenceCursor ? null : state.lastPassAt,
		"newest",
		state.evidenceCursor,
	);
	const resumed =
		state.evidenceCursor?.fragmentOffset && state.evidenceCursor.kind !== null
			? readEpisodicSource(db, { agentId, from: `${state.evidenceCursor.kind}:${state.evidenceCursor.id}` })
			: null;
	const remaining = resumed ? renderDreamingEvidence(resumed).slice(state.evidenceCursor?.fragmentOffset) : "";
	return queued.reduce((total, source) => total + countTokens(renderDreamingEvidence(source)), 0) + countTokens(remaining);
}

export function shouldTriggerDreaming(
	accessor: DbAccessor,
	cfg: DreamingConfig,
	agentId: string,
	nowMs = Date.now(),
	episodicTokens = getDreamingEpisodicTokenBacklog(accessor, agentId),
): boolean {
	const state = getDreamingState(accessor, agentId);

	// Back off by wall clock, not by evidence volume. A transient provider outage
	// must not require exponentially more incoming evidence before recovery.
	if (state.consecutiveFailures > 0) {
		const exp = Math.min(state.consecutiveFailures, MAX_FAILURE_BACKOFF_MULTIPLIER);
		const failedAt = state.lastFailureAt === null ? Number.NaN : Date.parse(state.lastFailureAt);
		if (!Number.isFinite(failedAt) || nowMs - failedAt < FAILURE_BACKOFF_BASE_MS * 2 ** exp) return false;
	}

	// First run only backfills when there is actual episodic evidence to reason
	// over. Semantic-only maintenance remains available through an explicit
	// compact pass rather than consuming a periodic inference turn with no input.
	if (cfg.backfillOnFirstRun && state.lastPassAt === null) return episodicTokens > 0;
	return episodicTokens >= cfg.tokenThreshold;
}

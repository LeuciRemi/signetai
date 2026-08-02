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
import { type EpisodicCursor, type EpisodicSourceRecord, readRecentEpisodicSources } from "../episodic-sources";
import { logger } from "../logger";
import { type OntologyOperationInput, applyOntologyOperationBatchInTx } from "../ontology-proposals";
import { extractBalancedJsonObjects } from "./extraction";
import { countTokens } from "./tokenizer";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DreamingMode = "incremental" | "compact";

type DreamingOperation = OntologyOperationInput;

export interface DreamingResult {
	readonly operations: readonly DreamingOperation[];
	readonly summary: string;
	readonly tokensConsumed: number;
	/** Operations discarded because they failed structural or evidence validation. */
	readonly invalidOperations: number;
}

export interface DreamingState {
	readonly consecutiveFailures: number;
	readonly lastPassAt: string | null;
	readonly evidenceCursor: EpisodicCursor | null;
	readonly lastPassId: string | null;
	readonly lastPassMode: string | null;
}

function parseEpisodicCursor(value: string | null): EpisodicCursor | null {
	if (!value) return null;
	try {
		const parsed = JSON.parse(value) as { capturedAt?: unknown; kind?: unknown; id?: unknown };
		if (typeof parsed.capturedAt !== "string" || typeof parsed.id !== "string") return null;
		if (
			parsed.kind !== null &&
			parsed.kind !== "artifact" &&
			parsed.kind !== "transcript" &&
			parsed.kind !== "summary"
		) {
			return null;
		}
		return { capturedAt: parsed.capturedAt, kind: parsed.kind ?? null, id: parsed.id };
	} catch {
		return null;
	}
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

export type LlmGenerateFn = (prompt: string, opts?: { timeoutMs?: number; maxTokens?: number }) => Promise<string>;

// ---------------------------------------------------------------------------
// Dreaming state DB helpers
// ---------------------------------------------------------------------------

function readDreamingState(db: ReadDb, agentId: string): DreamingState {
	let row:
		| {
				consecutive_failures: number;
				last_pass_at: string | null;
				evidence_cursor: string | null;
				last_pass_id: string | null;
				last_pass_mode: string | null;
		  }
		| undefined;
	try {
		row = db
			.prepare(
				`SELECT consecutive_failures,
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
			lastPassAt: null,
			evidenceCursor: null,
			lastPassId: null,
			lastPassMode: null,
		};
	}
	return {
		consecutiveFailures: row.consecutive_failures,
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
	evidenceCursor: EpisodicCursor,
	lastPassAt: string,
): void {
	const exists = db.prepare("SELECT 1 FROM dreaming_state WHERE agent_id = ?").get(agentId);
	if (exists) {
		db.prepare(
			`UPDATE dreaming_state
			 SET consecutive_failures = 0,
			     last_pass_at = ?,
			     evidence_cursor = ?,
			     last_pass_id = ?,
			     last_pass_mode = ?,
			     updated_at = datetime('now')
			 WHERE agent_id = ?`,
		).run(lastPassAt, JSON.stringify(evidenceCursor), passId, mode, agentId);
	} else {
		db.prepare(
			`INSERT INTO dreaming_state
			 (agent_id, consecutive_failures, last_pass_at, evidence_cursor, last_pass_id, last_pass_mode)
			 VALUES (?, 0, ?, ?, ?, ?)`,
		).run(agentId, lastPassAt, JSON.stringify(evidenceCursor), passId, mode);
	}
}

export function recordDreamingFailure(accessor: DbAccessor, agentId: string): void {
	accessor.withWriteTx((db) => {
		const exists = db.prepare("SELECT 1 FROM dreaming_state WHERE agent_id = ?").get(agentId);
		if (exists) {
			db.prepare(
				`UPDATE dreaming_state
				 SET consecutive_failures = consecutive_failures + 1,
				     updated_at = datetime('now')
				 WHERE agent_id = ?`,
			).run(agentId);
		} else {
			db.prepare(
				`INSERT INTO dreaming_state (agent_id, tokens_since_last_pass, consecutive_failures)
				 VALUES (?, 0, 1)`,
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
	return readRecentEpisodicSources(db, agentId, limit, undefined, since, "oldest", cursor);
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
			 FROM entities WHERE agent_id = ?
			 ORDER BY mentions DESC, updated_at DESC
			 LIMIT ?`,
		)
		.all(agentId, maxEntities) as EntityRow[];

	const aspects = db
		.prepare(
			`SELECT ea.id, ea.entity_id AS entityId, ea.name, ea.weight
			 FROM entity_aspects ea
			 WHERE ea.agent_id = ?
			 ORDER BY ea.weight DESC
			 LIMIT ?`,
		)
		.all(agentId, maxAspects) as AspectRow[];

	const attributes = db
		.prepare(
			`SELECT ea.id, ea.aspect_id AS aspectId, ea.kind, ea.content,
			        ea.status, ea.importance
			 FROM entity_attributes ea
			 WHERE ea.agent_id = ? AND ea.status = 'active'
			 ORDER BY ea.importance DESC
			 LIMIT ?`,
		)
		.all(agentId, maxAttrs) as AttributeRow[];

	const dependencies = db
		.prepare(
			`SELECT id, source_entity_id AS sourceEntityId,
			        target_entity_id AS targetEntityId,
			        dependency_type AS dependencyType,
			        strength, confidence, reason
			 FROM entity_dependencies
			 WHERE agent_id = ?
			 ORDER BY strength DESC, confidence DESC, updated_at DESC, id ASC
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
): {
	readonly prompt: string;
	readonly lastEvidence: EpisodicSourceRecord | null;
	readonly unrenderableEvidence: EpisodicSourceRecord | null;
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
	let unrenderableEvidence: EpisodicSourceRecord | null = null;
	for (const source of evidence) {
		const label = `${source.kind}:${source.sourceKind}`;
		const provenance = source.sourcePath ?? source.sourceId;
		const heading = `\n### ${label} (${source.capturedAt})${source.project ? ` — ${source.project}` : ""}\nSource: ${provenance}\n`;
		if (usedChars + heading.length + source.content.length > evidenceBudget) {
			unrenderableEvidence = lastEvidence === null ? source : null;
			break;
		}
		evidenceText += `${heading}${source.content}\n`;
		usedChars += heading.length + source.content.length;
		lastEvidence = source;
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

Respond with ONLY a JSON object in this exact format (no markdown code fences, no other text):

{
  "operations": [
    {
      "operation": "create_entity|create_aspect|add_claim_value|set_claim_value|supersede_claim_value|merge_entities|archive_entity|archive_aspect|archive_claim_value|create_link|update_link|archive_link",
      "payload": { "create_entity": { "name": "...", "entity_type": "project" }, "add_claim_value": { "entity": "...", "aspect": "...", "claim_key": "...", "value": "..." }, "merge_entities": { "target_entity": "...", "source_entities": ["..."] } },
      "reason": "why this semantic change is warranted",
      "confidence": 0.0,
      "evidence": [{ "source_kind": "copy exactly from an episodic_evidence heading", "source_id": "copy that source's provenance id", "source_path": "copy when present", "quote": "exact supporting quote from that source" }]
    }
  ],
  "summary": "Brief description of what you changed and why"
}`,
		lastEvidence,
		unrenderableEvidence,
	};
}

// ---------------------------------------------------------------------------
// Audited semantic operation validation
// ---------------------------------------------------------------------------

const DREAMING_OPERATIONS = new Set([
	"create_entity",
	"create_aspect",
	"add_claim_value",
	"set_claim_value",
	"supersede_claim_value",
	"merge_entities",
	"archive_entity",
	"archive_aspect",
	"archive_claim_value",
	"create_link",
	"update_link",
	"archive_link",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readNonEmptyString(value: unknown): string | null {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function evidenceMatchesSelectedSource(value: unknown, sources: readonly EpisodicSourceRecord[]): boolean {
	if (!isRecord(value)) return false;
	const sourceKind = readNonEmptyString(value.source_kind);
	const sourceId = readNonEmptyString(value.source_id);
	const sourcePath = readNonEmptyString(value.source_path);
	const quote = readNonEmptyString(value.quote);
	if (!sourceKind || !sourceId || !quote) return false;
	return sources.some(
		(source) =>
			source.sourceKind === sourceKind &&
			(source.sourceId === sourceId || source.id === sourceId) &&
			(sourcePath === null || source.sourcePath === sourcePath) &&
			source.content.includes(quote),
	);
}

function normalizeDreamingOperation(raw: unknown, sources: readonly EpisodicSourceRecord[]): DreamingOperation | null {
	if (!isRecord(raw)) return null;
	const operation = readNonEmptyString(raw.operation);
	const payload = raw.payload;
	const reason = readNonEmptyString(raw.reason) ?? readNonEmptyString(raw.rationale);
	const evidence = Array.isArray(raw.evidence) ? raw.evidence : [];
	if (!operation || !DREAMING_OPERATIONS.has(operation) || !isRecord(payload) || !reason || evidence.length === 0)
		return null;
	if (!evidence.every((item) => evidenceMatchesSelectedSource(item, sources))) return null;
	const confidence = raw.confidence;
	if (
		confidence !== undefined &&
		(typeof confidence !== "number" || !Number.isFinite(confidence) || confidence < 0 || confidence > 1)
	) {
		return null;
	}
	const firstEvidence = evidence[0] as Record<string, unknown>;
	return {
		operation,
		payload,
		reason,
		evidence,
		confidence: confidence as number | undefined,
		risk: readNonEmptyString(raw.risk),
		sourceKind: readNonEmptyString(firstEvidence.source_kind),
		sourceId: readNonEmptyString(firstEvidence.source_id),
		sourcePath: readNonEmptyString(firstEvidence.source_path),
		sourceRoot: "dreaming",
	};
}

function parseDreamingResult(raw: string, sources: readonly EpisodicSourceRecord[]): DreamingResult {
	const cleaned = raw.trim();
	let parsed: unknown;
	try {
		parsed = JSON.parse(cleaned);
	} catch (rawParseError) {
		for (const candidate of extractBalancedJsonObjects(cleaned)) {
			try {
				parsed = JSON.parse(candidate);
				break;
			} catch {
				// Keep scanning: prose may contain braces before the response object.
			}
		}
		if (parsed === undefined) throw rawParseError;
	}
	const result = isRecord(parsed) ? parsed : {};
	if (!Array.isArray(result.operations)) throw new Error("Dreaming response operations must be an array");
	const all = result.operations;
	const operations = all
		.map((operation) => normalizeDreamingOperation(operation, sources))
		.filter((operation): operation is DreamingOperation => operation !== null);
	const invalidOperations = all.length - operations.length;
	if (invalidOperations > 0) {
		logger.warn("dreaming", "LLM response contained invalid semantic operations — discarded", {
			count: invalidOperations,
		});
	}
	return {
		operations,
		summary: readNonEmptyString(result.summary) ?? "No summary provided",
		tokensConsumed: countTokens(raw),
		invalidOperations,
	};
}

// ---------------------------------------------------------------------------
// Main dreaming orchestrator
// ---------------------------------------------------------------------------

export async function runDreamingPass(
	accessor: DbAccessor,
	generate: LlmGenerateFn,
	cfg: DreamingConfig,
	agentsDir: string,
	agentId: string,
	mode: DreamingMode,
	existingPassId?: string,
): Promise<{ passId: string; applied: number; skipped: number; failed: number; summary: string }> {
	const passId = existingPassId ?? createDreamingPass(accessor, agentId, mode);
	const passStartedAt = new Date().toISOString();

	try {
		// Fetch data
		const state = getDreamingState(accessor, agentId);
		// Derive row limits from token budget — ~40% for graph, ~20 tokens per entity,
		// ~10 per aspect, ~25 per attribute, ~20 per dependency
		const graphTokenBudget = Math.floor(cfg.maxInputTokens * 0.4);
		const graphLimits = {
			entities: Math.max(100, Math.floor(graphTokenBudget / 20)),
			aspects: Math.max(200, Math.floor(graphTokenBudget / 10)),
			attributes: Math.max(500, Math.floor(graphTokenBudget / 25)),
			dependencies: Math.max(200, Math.floor(graphTokenBudget / 20)),
		};

		const { evidence, graph } = accessor.withReadDb((db) => {
			const evidence = fetchEpisodicEvidence(
				db,
				agentId,
				mode === "compact" || state.evidenceCursor ? null : state.lastPassAt,
				200,
				state.evidenceCursor,
			);
			const graph = fetchEntityGraph(db, agentId, graphLimits);
			return { evidence, graph };
		});

		warnIfTruncated(graph, graphLimits);

		if (mode === "incremental" && evidence.length === 0 && graph.entities.length === 0) {
			const evidenceCursor: EpisodicCursor = { capturedAt: passStartedAt, kind: null, id: "" };
			accessor.withWriteTx((db) => {
				db.prepare(
					`UPDATE dreaming_passes
					 SET status = 'completed',
					     completed_at = datetime('now'),
					     tokens_consumed = 0,
					     mutations_applied = 0,
					     mutations_skipped = 0,
					     mutations_failed = 0,
					     summary = ?
					 WHERE id = ?`,
				).run("No new episodic evidence or semantic entities to process", passId);
				resetDreamingTokens(db, agentId, passId, mode, evidenceCursor, passStartedAt);
			});
			return {
				passId,
				applied: 0,
				skipped: 0,
				failed: 0,
				summary: "No new episodic evidence or semantic entities to process",
			};
		}

		// Build prompt and call LLM
		const { prompt, lastEvidence, unrenderableEvidence } = buildDreamingPrompt(
			mode,
			evidence,
			graph,
			agentsDir,
			cfg.maxInputTokens,
		);
		if (unrenderableEvidence) {
			throw new Error(
				`Episodic evidence ${unrenderableEvidence.kind}:${unrenderableEvidence.id} exceeds the Dreaming prompt budget; split it into source artifacts before retrying`,
			);
		}
		const evidenceCursor: EpisodicCursor = lastEvidence
			? { capturedAt: lastEvidence.capturedAt, kind: lastEvidence.kind, id: lastEvidence.id }
			: (state.evidenceCursor ?? { capturedAt: passStartedAt, kind: null, id: "" });

		logger.info("dreaming", "Starting dreaming pass", {
			mode,
			episodicSources: evidence.length,
			entities: graph.entities.length,
			promptChars: prompt.length,
		});

		const raw = await generate(prompt, {
			timeoutMs: cfg.timeout,
			maxTokens: cfg.maxOutputTokens,
		});

		// Parse response — count actual tokens for both prompt and output
		const result = parseDreamingResult(raw, evidence);
		const promptTokens = countTokens(prompt);
		const totalTokens = promptTokens + result.tokensConsumed;

		logger.info("dreaming", "Dreaming pass produced semantic operations", {
			count: result.operations.length,
			promptTokens,
			outputTokens: result.tokensConsumed,
			summary: result.summary.slice(0, 200),
		});

		// Apply audited semantic operations and advance the cursor atomically.
		const { applied, skipped, failed } = accessor.withWriteTx((db) => {
			let applied = 0;
			let failed = result.invalidOperations;
			const errors: string[] = [];
			for (const operation of result.operations) {
				db.exec("SAVEPOINT dreaming_operation");
				try {
					applyOntologyOperationBatchInTx(db, { agentId, actor: "dreaming", operations: [operation] });
					db.exec("RELEASE SAVEPOINT dreaming_operation");
					applied++;
				} catch (error) {
					db.exec("ROLLBACK TO SAVEPOINT dreaming_operation");
					db.exec("RELEASE SAVEPOINT dreaming_operation");
					failed++;
					errors.push(error instanceof Error ? error.message : String(error));
				}
			}
			db.prepare(
				`UPDATE dreaming_passes
				 SET status = 'completed',
				     completed_at = datetime('now'),
				     tokens_consumed = ?,
				     mutations_applied = ?,
				     mutations_skipped = ?,
				     mutations_failed = ?,
				     summary = ?
				 WHERE id = ?`,
			).run(totalTokens, applied, 0, failed, result.summary, passId);
			resetDreamingTokens(db, agentId, passId, mode, evidenceCursor, passStartedAt);
			if (errors.length > 0)
				logger.warn("dreaming", "Some semantic operations were rejected", { errors: errors.slice(0, 10) });
			return { applied, skipped: 0, failed };
		});

		logger.info("dreaming", "Dreaming pass complete", {
			applied,
			skipped,
			failed,
			summary: result.summary.slice(0, 200),
		});

		return { passId, applied, skipped, failed, summary: result.summary };
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		logger.error("dreaming", "Dreaming pass failed", undefined, { error: msg });
		failDreamingPass(accessor, passId, msg);
		throw e;
	}
}

// ---------------------------------------------------------------------------
// Threshold check
// ---------------------------------------------------------------------------

// Max backoff: 5min * 2^6 = ~5.3 hours
const MAX_FAILURE_BACKOFF_MULTIPLIER = 6;

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
	return readRecentEpisodicSources(
		db,
		agentId,
		500,
		undefined,
		state.evidenceCursor ? null : state.lastPassAt,
		"newest",
		state.evidenceCursor,
	).reduce((total, source) => total + countTokens(source.content), 0);
}

export function shouldTriggerDreaming(accessor: DbAccessor, cfg: DreamingConfig, agentId: string): boolean {
	if (!cfg.enabled) return false;
	const state = getDreamingState(accessor, agentId);
	const episodicTokens = getDreamingEpisodicTokenBacklog(accessor, agentId);

	// Exponential backoff on consecutive failures: require tokens to
	// exceed threshold * 2^failures before retrying. The worker runs
	// every 5 min; this naturally delays retries (5min, 10min, 20min,
	// 40min, 80min, 160min, capped at ~5h).
	if (state.consecutiveFailures > 0) {
		const exp = Math.min(state.consecutiveFailures, MAX_FAILURE_BACKOFF_MULTIPLIER);
		const backoffChecks = 2 ** exp;

		// For first-run failures with backfill, require at least
		// tokenThreshold of episodic evidence before retrying (instead of
		// triggering unconditionally with 0 tokens)
		if (state.lastPassAt === null && cfg.backfillOnFirstRun) {
			return episodicTokens >= cfg.tokenThreshold;
		}

		// For all other cases, multiply the threshold by the backoff factor
		return episodicTokens >= cfg.tokenThreshold * backoffChecks;
	}

	// First run only backfills when there is actual episodic evidence to reason
	// over. Semantic-only maintenance remains available through an explicit
	// compact pass rather than consuming a periodic inference turn with no input.
	if (cfg.backfillOnFirstRun && state.lastPassAt === null) return episodicTokens > 0;
	return episodicTokens >= cfg.tokenThreshold;
}

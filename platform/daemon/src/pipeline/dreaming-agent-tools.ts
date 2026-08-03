/**
 * Daemon-owned Pi ToolDefinition factory for the #946 conceptual ontology tool
 * set exposed to dreaming/agent sessions.
 *
 * This module is intentionally additive: it owns no daemon state, performs no
 * routing, and touches no existing pipeline files. It assembles a fixed set of
 * seven read tools plus one write tool, reusing the existing knowledge-graph,
 * ontology evidence, episodic-sources, and ontology-proposals modules.
 *
 * Scoping rules enforced here (see AGENTS.md "Durable data contracts"):
 * - Every read and write is agent-scoped via the `agentId` captured by the
 *   factory. The tool parameter schemas never accept an agent id, so callers
 *   cannot read or mutate another agent's graph.
 * - Writes flow through `applyOntologyOperationBatchInTx` on a caller-owned
 *   write transaction with one SAVEPOINT per operation, so a single failing op
 *   rolls back only itself while the rest of the batch still applies.
 * - Source citations are only accepted when the quoted text is an exact
 *   substring of an evidence record's content that was explicitly passed into
 *   the factory. Unrelated or unsupplied quotes are rejected.
 * - No direct table SQL lives here; all persistence goes through the reused
 *   modules, which already enforce agent scoping and evidence provenance.
 */
import * as Type from "typebox";
import type { TSchema } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

import type { DbAccessor } from "../db-accessor";
import { searchEpisodicSources, type EpisodicSourceRecord } from "../episodic-sources";
import {
	getEntityDependenciesDetailed,
	getEntityAspectsWithCounts,
	getKnowledgeEntityDetail,
	getAttributesForAspectFiltered,
	listKnowledgeEntities,
} from "../knowledge-graph";
import { getOntologyClaimEvidence } from "../ontology-claim-evidence";
import { getOntologyLinkEvidence } from "../ontology-link-evidence";
import type { DreamingAgentEvidence } from "./dreaming-evidence";
import { applyDreamingOperations, type ApplyDreamingOperationsResult } from "./dreaming-operations";

export type { DreamingAgentEvidence } from "./dreaming-evidence";

/** Shape of every tool result returned to the agent. */
export interface DreamingAgentToolResult {
	readonly tool: string;
	readonly ok: boolean;
	readonly error?: string;
	readonly [key: string]: unknown;
}

/**
 * Build a single text tool result. Tool results are JSON, never truncated.
 */
function textResult(payload: DreamingAgentToolResult): { readonly type: "text"; readonly text: string } {
	return { type: "text", text: JSON.stringify(payload) };
}

export interface CreateDreamingAgentToolsParams {
	readonly accessor: DbAccessor;
	readonly agentId: string;
	readonly actor: string;
	/** Evidence records the agent may quote from. Empty means no citations allowed. */
	readonly evidence?: readonly DreamingAgentEvidence[];
	/** Lets the pass lifecycle account for immediate audited writes. */
	readonly onOperationsApplied?: (result: ApplyDreamingOperationsResult) => void;
}

/**
 * Factory for the daemon-owned conceptual ontology tool set. Returns the seven
 * read tools plus `apply_ontology_ops`, all closed over the supplied agentId.
 */
export function createDreamingAgentTools(params: CreateDreamingAgentToolsParams): readonly ToolDefinition<TSchema>[] {
	const { accessor, agentId, actor } = params;
	const evidence = params.evidence ?? [];

	const searchEntities: ToolDefinition<TSchema> = {
		name: "search_entities",
		label: "Search entities",
		description: "Search the agent's knowledge graph entities by name fragment and optional type.",
		parameters: Type.Object({
			query: Type.Optional(Type.String()),
			type: Type.Optional(Type.String()),
			limit: Type.Optional(Type.Number()),
			offset: Type.Optional(Type.Number()),
		}),
		async execute(_toolCallId, rawParams) {
			const p = rawParams as { query?: string; type?: string; limit?: number; offset?: number };
			const limit = Math.max(1, Math.min(Math.floor(p.limit ?? 20), 100));
			const offset = Math.max(0, Math.floor(p.offset ?? 0));
			const items = listKnowledgeEntities(accessor, {
				agentId,
				query: p.query,
				type: p.type,
				limit,
				offset,
			});
			return {
				content: [
					textResult({
						tool: "search_entities",
						ok: true,
						items: items.map((item) => ({
							id: item.entity.id,
							name: item.entity.name,
							entityType: item.entity.entityType,
							aspectCount: item.aspectCount,
							attributeCount: item.attributeCount,
							constraintCount: item.constraintCount,
							dependencyCount: item.dependencyCount,
						})),
					}),
				],
				details: { tool: "search_entities" },
			};
		},
	};

	const getEntity: ToolDefinition<TSchema> = {
		name: "get_entity",
		label: "Get entity detail",
		description: "Fetch a single entity and its aspects with attribute/constraint counts.",
		parameters: Type.Object({
			entityId: Type.String(),
		}),
		async execute(_toolCallId, rawParams) {
			const p = rawParams as { entityId: string };
			const detail = getKnowledgeEntityDetail(accessor, p.entityId, agentId);
			if (detail === null) {
				return {
					content: [textResult({ tool: "get_entity", ok: false, error: "Entity not found" })],
					details: { tool: "get_entity" },
				};
			}
			const aspects = getEntityAspectsWithCounts(accessor, p.entityId, agentId);
			return {
				content: [
					textResult({
						tool: "get_entity",
						ok: true,
						entity: detail.entity,
						aspectCount: detail.aspectCount,
						attributeCount: detail.attributeCount,
						constraintCount: detail.constraintCount,
						dependencyCount: detail.dependencyCount,
						aspects: aspects.map((aspect) => ({
							id: aspect.aspect.id,
							name: aspect.aspect.name,
							attributeCount: aspect.attributeCount,
							constraintCount: aspect.constraintCount,
						})),
					}),
				],
				details: { tool: "get_entity" },
			};
		},
	};

	const listAspectClaims: ToolDefinition<TSchema> = {
		name: "list_aspect_claims",
		label: "List aspect claims",
		description: "List claim attributes (values) for a specific entity aspect.",
		parameters: Type.Object({
			entityId: Type.String(),
			aspectId: Type.String(),
			limit: Type.Optional(Type.Number()),
			offset: Type.Optional(Type.Number()),
		}),
		async execute(_toolCallId, rawParams) {
			const p = rawParams as { entityId: string; aspectId: string; limit?: number; offset?: number };
			const limit = Math.max(1, Math.min(Math.floor(p.limit ?? 50), 200));
			const offset = Math.max(0, Math.floor(p.offset ?? 0));
			const attributes = getAttributesForAspectFiltered(accessor, {
				entityId: p.entityId,
				aspectId: p.aspectId,
				agentId,
				kind: "attribute",
				status: "active",
				limit,
				offset,
			});
			return {
				content: [
					textResult({
						tool: "list_aspect_claims",
						ok: true,
						items: attributes,
					}),
				],
				details: { tool: "list_aspect_claims" },
			};
		},
	};

	const walkLinks: ToolDefinition<TSchema> = {
		name: "walk_links",
		label: "Walk dependency links",
		description: "Walk incoming and/or outgoing dependency links for an entity.",
		parameters: Type.Object({
			entityId: Type.String(),
			direction: Type.Optional(Type.Union([Type.Literal("incoming"), Type.Literal("outgoing"), Type.Literal("both")])),
		}),
		async execute(_toolCallId, rawParams) {
			const p = rawParams as { entityId: string; direction?: "incoming" | "outgoing" | "both" };
			const direction = p.direction ?? "both";
			const edges = getEntityDependenciesDetailed(accessor, { entityId: p.entityId, agentId, direction });
			return {
				content: [
					textResult({
						tool: "walk_links",
						ok: true,
						items: edges,
					}),
				],
				details: { tool: "walk_links" },
			};
		},
	};

	const getClaimEvidence: ToolDefinition<TSchema> = {
		name: "get_claim_evidence",
		label: "Get claim evidence",
		description: "Resolve source evidence for a claim attribute path. Evidence content is returned in full.",
		parameters: Type.Object({
			entity: Type.String(),
			aspect: Type.String(),
			group: Type.String(),
			claim: Type.String(),
			limit: Type.Optional(Type.Number()),
			offset: Type.Optional(Type.Number()),
		}),
		async execute(_toolCallId, rawParams) {
			const p = rawParams as { entity: string; aspect: string; group: string; claim: string; limit?: number; offset?: number };
			try {
				const result = getOntologyClaimEvidence(accessor, {
					agentId,
					entity: p.entity,
					aspect: p.aspect,
					group: p.group,
					claim: p.claim,
					limit: p.limit,
					offset: p.offset,
				});
				return {
					content: [textResult({ tool: "get_claim_evidence", ok: true, result })],
					details: { tool: "get_claim_evidence" },
				};
			} catch (err) {
				return {
					content: [
						textResult({
							tool: "get_claim_evidence",
							ok: false,
							error: err instanceof Error ? err.message : String(err),
						}),
					],
					details: { tool: "get_claim_evidence" },
				};
			}
		},
	};

	const getLinkEvidence: ToolDefinition<TSchema> = {
		name: "get_link_evidence",
		label: "Get link evidence",
		description: "Resolve source evidence for a dependency link by id. Evidence content is returned in full.",
		parameters: Type.Object({
			id: Type.String(),
		}),
		async execute(_toolCallId, rawParams) {
			const p = rawParams as { id: string };
			try {
				const result = getOntologyLinkEvidence(accessor, { agentId, id: p.id });
				return {
					content: [textResult({ tool: "get_link_evidence", ok: true, result })],
					details: { tool: "get_link_evidence" },
				};
			} catch (err) {
				return {
					content: [
						textResult({
							tool: "get_link_evidence",
							ok: false,
							error: err instanceof Error ? err.message : String(err),
						}),
					],
					details: { tool: "get_link_evidence" },
				};
			}
		},
	};

	const searchEvidence: ToolDefinition<TSchema> = {
		name: "search_evidence",
		label: "Search episodic evidence",
		description: "Full-text search across episodic memories, artifacts, transcripts, and summaries.",
		parameters: Type.Object({
			query: Type.String(),
			limit: Type.Optional(Type.Number()),
		}),
		async execute(_toolCallId, rawParams) {
			const p = rawParams as { query: string; limit?: number };
			const records: EpisodicSourceRecord[] = accessor.withReadDb((db) =>
				searchEpisodicSources(db, { agentId, query: p.query, limit: p.limit }),
			);
			return {
				content: [
					textResult({
						tool: "search_evidence",
						ok: true,
						items: records,
					}),
				],
				details: { tool: "search_evidence" },
			};
		},
	};

	const applyOntologyOps: ToolDefinition<TSchema> = {
		name: "apply_ontology_ops",
		label: "Apply ontology operations",
		description:
			"Apply a batch of audited ontology operations inside a single caller-owned transaction with per-op isolation. " +
			"Every evidence quote must be an exact substring of an evidence record supplied to the session.",
		parameters: Type.Object({
			operations: Type.Array(
				Type.Object({
					operation: Type.String(),
					payload: Type.Record(Type.String(), Type.Unknown()),
					reason: Type.Optional(Type.String()),
					evidence: Type.Optional(Type.Array(Type.Unknown())),
					confidence: Type.Optional(Type.Number()),
					risk: Type.Optional(Type.Union([Type.String(), Type.Null()])),
				}),
			),
		}),
		async execute(_toolCallId, rawParams) {
			const p = rawParams as {
				operations: Array<{
					operation: string;
					payload: Record<string, unknown>;
					reason?: string;
					evidence?: readonly unknown[];
					confidence?: number;
					risk?: string | null;
				}>;
			};

			if (!Array.isArray(p.operations) || p.operations.length === 0) {
				return {
					content: [textResult({ tool: "apply_ontology_ops", ok: false, error: "operations are required" })],
					details: { tool: "apply_ontology_ops" },
				};
			}

			const result = applyDreamingOperations({ accessor, agentId, actor, operations: p.operations, allowedEvidence: evidence });
			params.onOperationsApplied?.(result);
			return {
				content: [
					textResult({
						tool: "apply_ontology_ops",
						ok: result.ok,
						...(result.error ? { error: result.error } : {}),
						items: result.items,
					}),
				],
				details: { tool: "apply_ontology_ops" },
			};
		},
	};

	return [
		searchEntities,
		getEntity,
		listAspectClaims,
		walkLinks,
		getClaimEvidence,
		getLinkEvidence,
		searchEvidence,
		applyOntologyOps,
	];
}

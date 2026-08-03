/**
 * Canonical Dreaming capability registry.
 *
 * Pi sessions invoke these handlers in-process; MCP and CLI invoke the daemon
 * capability route. The registry is therefore the one owner of capability
 * names, schemas, scope, validation, and graph/evidence reads.
 */
import { z } from "zod";
import type { DbAccessor } from "../db-accessor";
import { searchEpisodicSources } from "../episodic-sources";
import {
	getAttributesForAspectFiltered,
	getEntityAspectsWithCounts,
	getEntityDependenciesDetailed,
	getKnowledgeEntityDetail,
	listKnowledgeEntities,
} from "../knowledge-graph";
import { getOntologyClaimEvidence } from "../ontology-claim-evidence";
import { getOntologyLinkEvidence } from "../ontology-link-evidence";
import type { DreamingAgentEvidence } from "./dreaming-evidence";
import { applyDreamingOperations, type ApplyDreamingOperationsResult, type DreamingOperationRequest } from "./dreaming-operations";

const bounded = (value: number | undefined, fallback: number, max: number): number =>
	Math.min(Math.max(Math.floor(value ?? fallback), 1), max);

const pagination = {
	limit: z.number().finite().optional(),
	offset: z.number().finite().optional(),
};

const operationSchema = z.object({
	operation: z.string(),
	payload: z.object({}).catchall(z.unknown()),
	reason: z.string().optional(),
	evidence: z.array(z.unknown()).optional(),
	confidence: z.number().finite().optional(),
	risk: z.string().nullable().optional(),
});

export const DREAMING_CAPABILITY_IDS = [
	"search_entities",
	"get_entity",
	"list_aspect_claims",
	"walk_links",
	"get_claim_evidence",
	"get_link_evidence",
	"search_evidence",
	"apply_ontology_ops",
] as const;

export type DreamingCapabilityId = (typeof DREAMING_CAPABILITY_IDS)[number];

export interface DreamingCapabilityResult {
	readonly tool: DreamingCapabilityId;
	readonly ok: boolean;
	readonly error?: string;
	readonly [key: string]: unknown;
}

export interface DreamingCapability {
	readonly id: DreamingCapabilityId;
	readonly title: string;
	readonly description: string;
	readonly readOnly: boolean;
	readonly inputSchema: z.ZodType;
	invoke(input: unknown): Promise<DreamingCapabilityResult>;
}

export interface CreateDreamingCapabilitiesParams {
	readonly accessor: DbAccessor;
	readonly agentId: string;
	readonly actor: string;
	readonly evidence?: readonly DreamingAgentEvidence[];
	readonly onOperationsApplied?: (
		result: ApplyDreamingOperationsResult,
		operations: readonly DreamingOperationRequest[],
	) => void;
}

export interface DreamingCapabilityManifestEntry {
	readonly id: DreamingCapabilityId;
	readonly title: string;
	readonly description: string;
	readonly readOnly: boolean;
	readonly inputSchema: Record<string, unknown>;
}

function capability<T extends z.ZodType>(
	id: DreamingCapabilityId,
	title: string,
	description: string,
	readOnly: boolean,
	inputSchema: T,
	run: (input: z.output<T>) => Promise<Omit<DreamingCapabilityResult, "tool">>,
): DreamingCapability {
	return {
		id,
		title,
		description,
		readOnly,
		inputSchema,
		async invoke(input) {
			const parsed = inputSchema.safeParse(input);
			if (!parsed.success) {
				return { tool: id, ok: false, error: parsed.error.issues.map((issue) => issue.message).join("; ") };
			}
			try {
				return { tool: id, ...(await run(parsed.data)) };
			} catch (error) {
				return { tool: id, ok: false, error: error instanceof Error ? error.message : String(error) };
			}
		},
	};
}

/** The one scope-bound handler registry used by Pi, daemon HTTP, MCP, and CLI. */
export function createDreamingCapabilities(params: CreateDreamingCapabilitiesParams): readonly DreamingCapability[] {
	const { accessor, agentId, actor } = params;
	const evidence = params.evidence ?? [];
	return [
		capability(
			"search_entities",
			"Search entities",
			"Search the scoped knowledge graph by entity name fragment and optional type.",
			true,
			z.object({ query: z.string().optional(), type: z.string().optional(), ...pagination }),
			async ({ query, type, limit, offset }) => ({
				ok: true,
				items: listKnowledgeEntities(accessor, {
					agentId,
					query,
					type,
					limit: bounded(limit, 20, 100),
					offset: Math.max(0, Math.floor(offset ?? 0)),
				}).map((item) => ({
					id: item.entity.id,
					name: item.entity.name,
					entityType: item.entity.entityType,
					aspectCount: item.aspectCount,
					attributeCount: item.attributeCount,
					constraintCount: item.constraintCount,
					dependencyCount: item.dependencyCount,
				})),
			}),
		),
		capability(
			"get_entity",
			"Get entity detail",
			"Fetch one scoped entity and its aspects with attribute and constraint counts.",
			true,
			z.object({ entityId: z.string().min(1) }),
			async ({ entityId }) => {
				const detail = getKnowledgeEntityDetail(accessor, entityId, agentId);
				if (!detail) return { ok: false, error: "Entity not found" };
				return {
					ok: true,
					entity: detail.entity,
					aspectCount: detail.aspectCount,
					attributeCount: detail.attributeCount,
					constraintCount: detail.constraintCount,
					dependencyCount: detail.dependencyCount,
					aspects: getEntityAspectsWithCounts(accessor, entityId, agentId).map((aspect) => ({
						id: aspect.aspect.id,
						name: aspect.aspect.name,
						attributeCount: aspect.attributeCount,
						constraintCount: aspect.constraintCount,
					})),
				};
			},
		),
		capability(
			"list_aspect_claims",
			"List aspect claims",
			"List active claim attributes for one scoped entity aspect by stable ids.",
			true,
			z.object({ entityId: z.string().min(1), aspectId: z.string().min(1), ...pagination }),
			async ({ entityId, aspectId, limit, offset }) => ({
				ok: true,
				items: getAttributesForAspectFiltered(accessor, {
					entityId,
					aspectId,
					agentId,
					kind: "attribute",
					status: "active",
					limit: bounded(limit, 50, 200),
					offset: Math.max(0, Math.floor(offset ?? 0)),
				}),
			}),
		),
		capability(
			"walk_links",
			"Walk dependency links",
			"Walk incoming and/or outgoing scoped dependency links for an entity.",
			true,
			z.object({ entityId: z.string().min(1), direction: z.enum(["incoming", "outgoing", "both"]).optional() }),
			async ({ entityId, direction }) => ({
				ok: true,
				items: getEntityDependenciesDetailed(accessor, { entityId, agentId, direction: direction ?? "both" }),
			}),
		),
		capability(
			"get_claim_evidence",
			"Get claim evidence",
			"Resolve provenance for a scoped claim path.",
			true,
			z.object({ entity: z.string().min(1), aspect: z.string().min(1), group: z.string().min(1), claim: z.string().min(1), ...pagination }),
			async ({ entity, aspect, group, claim, limit, offset }) => ({
				ok: true,
				result: getOntologyClaimEvidence(accessor, { agentId, entity, aspect, group, claim, limit, offset }),
			}),
		),
		capability(
			"get_link_evidence",
			"Get link evidence",
			"Resolve provenance for a scoped dependency link by stable id.",
			true,
			z.object({ id: z.string().min(1) }),
			async ({ id }) => ({ ok: true, result: getOntologyLinkEvidence(accessor, { agentId, id }) }),
		),
		capability(
			"search_evidence",
			"Search episodic evidence",
			"Full-text search immutable episodic memories, artifacts, transcripts, and summaries in this scope.",
			true,
			z.object({ query: z.string().min(1), limit: z.number().finite().optional() }),
			async ({ query, limit }) => ({
				ok: true,
				items: accessor.withReadDb((db) => searchEpisodicSources(db, { agentId, query, limit })),
			}),
		),
		capability(
			"apply_ontology_ops",
			"Apply ontology operations",
			"Apply cited ontology operations through the daemon audit seam. Every quote must be exact evidence.",
			false,
			z.object({ operations: z.array(operationSchema).min(1).max(100) }),
			async ({ operations }) => {
				const result = applyDreamingOperations({ accessor, agentId, actor, operations, allowedEvidence: evidence });
				params.onOperationsApplied?.(result, operations);
				return { ok: result.ok, ...(result.error ? { error: result.error } : {}), items: result.items };
			},
		),
	];
}

export function getDreamingCapability(
	params: CreateDreamingCapabilitiesParams,
	id: string,
): DreamingCapability | undefined {
	return createDreamingCapabilities(params).find((candidate) => candidate.id === id);
}

/** Public metadata lets CLI and MCP discover the exact registry without a second list. */
export function getDreamingCapabilityManifest(): readonly DreamingCapabilityManifestEntry[] {
	return createDreamingCapabilities({
		accessor: undefined as never,
		agentId: "manifest",
		actor: "manifest",
	}).map((capability) => ({
		id: capability.id,
		title: capability.title,
		description: capability.description,
		readOnly: capability.readOnly,
		inputSchema: z.toJSONSchema(capability.inputSchema) as Record<string, unknown>,
	}));
}

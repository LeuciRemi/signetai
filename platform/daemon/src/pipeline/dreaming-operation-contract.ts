/**
 * Model-facing contract for the daemon-owned ontology apply seam.
 *
 * Ontology proposal application remains the authoritative validator. This
 * contract lifts its accepted operation vocabulary and payload shapes into the
 * capability schema so Pi, MCP, and CLI callers do not need to discover them
 * by failed mutations.
 */
import { ATTRIBUTE_KINDS, DEPENDENCY_TYPES, ENTITY_TYPES, ONTOLOGY_PROPOSAL_OPERATIONS } from "@signet/core";
import { z } from "zod";

const text = z.string().min(1);
const score = z.number().finite();
const bool = z.union([z.boolean(), z.literal(0), z.literal(1), z.literal("0"), z.literal("1"), z.literal("true")]);
const entityType = z.enum(ENTITY_TYPES).describe("The entity's ontology type. Choose the most specific supported type.");
const entityName = text.describe("A stable, human-readable entity name.");
const aspectName = text.describe("The specific domain of knowledge this claim belongs to.");
const claimValue = text.describe("A complete atomic assertion that is understandable on its own.");
const claimKey = text.describe("A stable semantic slot key for versions of the same claim.");

function oneOf(keys: readonly string[]): (value: Record<string, unknown>) => boolean {
	return (value) => keys.some((key) => typeof value[key] === "string" && value[key].trim().length > 0);
}

function payload<T extends z.ZodRawShape>(shape: T) {
	return z.object(shape).passthrough();
}

const entitySelector = {
	selector: text.optional(),
	entity: text.optional(),
	entity_id: text.optional(),
	name: text.optional(),
};

const aspectSelector = {
	selector: text.optional(),
	aspect: text.optional(),
	aspect_id: text.optional(),
	name: text.optional(),
};

const claimPayload = {
	entity: entityName,
	aspect: aspectName,
	claim_key: claimKey.optional(),
	claim: text.optional(),
	value: claimValue,
	entity_type: entityType.optional(),
	group_key: text.optional(),
	group: text.optional(),
	kind: z.enum(ATTRIBUTE_KINDS).optional(),
	confidence: score.optional(),
	importance: score.optional(),
	force: bool.optional(),
};

const entitySelectionMessage = "Provide one of selector, entity, entity_id, or name";
const aspectSelectionMessage = "Provide one of selector, aspect, aspect_id, or name";

/**
 * One map is shared by the capability registry and generic MCP binding.
 * Keep aliases aligned with the proposal applicators: those applicators remain
 * the source of behavioral truth and still validate graph state.
 */
export const DREAMING_ONTOLOGY_PAYLOAD_SCHEMAS = {
	create_entity: payload({ name: entityName, entity_type: entityType.optional() }),
	add_claim_value: payload({ ...claimPayload, claim_key: claimKey }),
	set_claim_value: payload(claimPayload).refine(
		(value) => oneOf(["claim_key", "claim"])(value),
		"Provide claim_key or claim",
	),
	rename_entity: payload({ ...entitySelector, new_name: text }).refine(
		(value) => oneOf(["selector", "entity", "entity_id", "name"])(value),
		entitySelectionMessage,
	),
	archive_entity: payload({ ...entitySelector, reason: text.optional(), force: bool.optional() }).refine(
		(value) => oneOf(["selector", "entity", "entity_id", "name"])(value),
		entitySelectionMessage,
	),
	create_aspect: payload({ entity: entityName.optional(), entity_id: text.optional(), name: aspectName.optional(), aspect: aspectName.optional() })
		.refine((value) => oneOf(["entity", "entity_id"])(value), "Provide entity or entity_id")
		.refine((value) => oneOf(["name", "aspect"])(value), "Provide name or aspect"),
	rename_aspect: payload({ ...entitySelector, ...aspectSelector, new_name: text }).refine(
		(value) => oneOf(["entity", "entity_id"])(value),
		"Provide entity or entity_id",
	).refine((value) => oneOf(["selector", "aspect", "aspect_id", "name"])(value), aspectSelectionMessage),
	archive_aspect: payload({ ...entitySelector, ...aspectSelector, reason: text.optional(), force: bool.optional() })
		.refine((value) => oneOf(["entity", "entity_id"])(value), "Provide entity or entity_id")
		.refine((value) => oneOf(["selector", "aspect", "aspect_id", "name"])(value), aspectSelectionMessage),
	archive_claim_value: payload({ attribute_id: text, reason: text.optional(), force: bool.optional() }),
	restore_claim_version: payload({ attribute_id: text }),
	create_link: payload({
		source_entity: text.optional(),
		source_entity_id: text.optional(),
		target_entity: text.optional(),
		target_entity_id: text.optional(),
		link_type: z.enum(DEPENDENCY_TYPES),
		reason: text.optional(),
		strength: score.optional(),
		confidence: score.optional(),
		source_type: entityType.optional(),
		target_type: entityType.optional(),
	}).refine((value) => oneOf(["source_entity", "source_entity_id"])(value), "Provide source_entity or source_entity_id")
		.refine((value) => oneOf(["target_entity", "target_entity_id"])(value), "Provide target_entity or target_entity_id"),
	update_link: payload({
		id: text.optional(),
		dependency_id: text.optional(),
		link_id: text.optional(),
		link_type: z.enum(DEPENDENCY_TYPES).optional(),
		reason: text.optional(),
		strength: score.optional(),
		confidence: score.optional(),
	}).refine((value) => oneOf(["id", "dependency_id", "link_id"])(value), "Provide id, dependency_id, or link_id"),
	archive_link: payload({ id: text.optional(), dependency_id: text.optional(), link_id: text.optional(), reason: text.optional() }).refine(
		(value) => oneOf(["id", "dependency_id", "link_id"])(value),
		"Provide id, dependency_id, or link_id",
	),
	merge_entities: payload({
		target_entity: text.optional(),
		target: text.optional(),
		target_entity_id: text.optional(),
		target_id: text.optional(),
		source_entities: z.array(text).min(1).optional(),
		sources: z.array(text).min(1).optional(),
		source_entity: text.optional(),
		source: text.optional(),
		source_entity_ids: z.array(text).min(1).optional(),
		source_ids: z.array(text).min(1).optional(),
		source_entity_id: text.optional(),
		source_id: text.optional(),
		force: bool.optional(),
	}).refine((value) => oneOf(["target_entity", "target", "target_entity_id", "target_id"])(value), "Provide a target entity selector")
		.refine(
			(value) =>
				oneOf(["source_entity", "source", "source_entity_id", "source_id"])(value) ||
				(value.source_entities?.length ?? 0) > 0 ||
				(value.sources?.length ?? 0) > 0 ||
				(value.source_entity_ids?.length ?? 0) > 0 ||
				(value.source_ids?.length ?? 0) > 0,
			"Provide at least one source entity selector",
		),
	supersede_claim_value: payload({
		entity: text,
		aspect: text,
		claim_key: text,
		group_key: text.optional(),
		kind: z.enum(ATTRIBUTE_KINDS).optional(),
		attribute_id: text.optional(),
		old_value: text.optional(),
		new_value: text.optional(),
		superseded_by: text.optional(),
		confidence: score.optional(),
		importance: score.optional(),
		entity_type: entityType.optional(),
	}).refine((value) => oneOf(["attribute_id", "old_value"])(value), "Provide attribute_id or old_value"),
	create_policy: payload({
		target_entity: text.optional(),
		entity: text.optional(),
		entity_id: text.optional(),
		kind: text,
		content: text,
		entity_type: entityType.optional(),
		confidence: score.optional(),
		importance: score.optional(),
	}).refine((value) => oneOf(["target_entity", "entity", "entity_id"])(value), "Provide target_entity, entity, or entity_id"),
	create_action_type: payload({ name: text.optional(), action_type: text.optional() }).refine(
		(value) => oneOf(["name", "action_type"])(value),
		"Provide name or action_type",
	),
	create_interface: payload({ name: text.optional(), interface: text.optional() }).refine(
		(value) => oneOf(["name", "interface"])(value),
		"Provide name or interface",
	),
	attach_interface: payload({
		entity: text.optional(),
		source_entity: text.optional(),
		target_entity: text.optional(),
		interface: text.optional(),
		interface_name: text.optional(),
		target_interface: text.optional(),
		reason: text.optional(),
		strength: score.optional(),
		confidence: score.optional(),
	}).refine((value) => oneOf(["entity", "source_entity", "target_entity"])(value), "Provide entity or source_entity")
		.refine((value) => oneOf(["interface", "interface_name", "target_interface"])(value), "Provide interface or interface_name"),
} as const satisfies Record<(typeof ONTOLOGY_PROPOSAL_OPERATIONS)[number], z.ZodType>;

const operationBase = {
	reason: z.string().optional(),
	evidence: z.array(z.unknown()).optional(),
	provenance: z
		.string()
		.min(1)
		.describe("For a flagged hygiene archive, use attention:<id>; content-bearing writes require episodic evidence.")
		.optional(),
	confidence: z.number().finite().optional(),
	risk: z.string().nullable().optional(),
};

function operation<T extends (typeof ONTOLOGY_PROPOSAL_OPERATIONS)[number]>(id: T) {
	return z.object({ operation: z.literal(id), payload: DREAMING_ONTOLOGY_PAYLOAD_SCHEMAS[id], ...operationBase });
}

export const DREAMING_ONTOLOGY_OPERATION_SCHEMA = z.discriminatedUnion("operation", [
	operation("create_entity"),
	operation("add_claim_value"),
	operation("set_claim_value"),
	operation("rename_entity"),
	operation("archive_entity"),
	operation("create_aspect"),
	operation("rename_aspect"),
	operation("archive_aspect"),
	operation("archive_claim_value"),
	operation("restore_claim_version"),
	operation("create_link"),
	operation("update_link"),
	operation("archive_link"),
	operation("merge_entities"),
	operation("supersede_claim_value"),
	operation("create_policy"),
	operation("create_action_type"),
	operation("create_interface"),
	operation("attach_interface"),
]);

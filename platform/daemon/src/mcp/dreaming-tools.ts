/**
 * The restricted MCP binding used only by external Dreaming agents.
 *
 * It deliberately mirrors the conceptual Pi tool surface while fixing the
 * agent scope at process construction. The model receives no agent-id input,
 * no generic memory mutation tools, and no database handle.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { buildRecallRequestBody } from "@signet/core";
import { z } from "zod";
import { daemonFetch, errorResult, textResult } from "./tools.js";

export interface DreamingMcpServerOptions {
	readonly daemonUrl: string;
	readonly agentId: string;
	readonly version: string;
}

function bounded(value: number | undefined, fallback: number, max: number): number {
	if (!Number.isFinite(value)) return fallback;
	return Math.min(Math.max(Math.floor(value ?? fallback), 1), max);
}

function scopedPath(path: string, agentId: string, values: Readonly<Record<string, string | number | undefined>> = {}): string {
	const params = new URLSearchParams({ agent_id: agentId });
	for (const [key, value] of Object.entries(values)) {
		if (value !== undefined) params.set(key, String(value));
	}
	return `${path}?${params.toString()}`;
}

/** Create the only MCP server an ACPX Dreaming pass may access. */
export function createDreamingMcpServer(options: DreamingMcpServerOptions): McpServer {
	const server = new McpServer({ name: "signet-dreaming", version: options.version });
	const get = async (path: string, label: string) => {
		const result = await daemonFetch<unknown>(options.daemonUrl, path);
		return result.ok ? textResult(result.data) : errorResult(`${label} failed: ${result.error}`);
	};

	server.registerTool(
		"search_entities",
		{
			title: "Search entities",
			description: "Search this Dreaming pass's scoped knowledge graph.",
			inputSchema: z.object({
				query: z.string().optional(),
				type: z.string().optional(),
				limit: z.number().optional(),
				offset: z.number().optional(),
			}),
			annotations: { readOnlyHint: true },
		},
		async ({ query, type, limit, offset }) =>
			get(
				scopedPath("/api/knowledge/entities", options.agentId, {
					q: query,
					type,
					limit: bounded(limit, 20, 100),
					offset: Math.max(0, Math.floor(offset ?? 0)),
				}),
				"Entity search",
			),
	);

	server.registerTool(
		"get_entity",
		{
			title: "Get entity detail",
			description: "Fetch an entity and its scoped semantic detail by stable id.",
			inputSchema: z.object({ entityId: z.string() }),
			annotations: { readOnlyHint: true },
		},
		async ({ entityId }) => get(scopedPath(`/api/knowledge/entities/${encodeURIComponent(entityId)}`, options.agentId), "Entity get"),
	);

	server.registerTool(
		"list_aspect_claims",
		{
			title: "List aspect claims",
			description: "List active claim attributes for one entity aspect by stable ids.",
			inputSchema: z.object({
				entityId: z.string(),
				aspectId: z.string(),
				limit: z.number().optional(),
				offset: z.number().optional(),
			}),
			annotations: { readOnlyHint: true },
		},
		async ({ entityId, aspectId, limit, offset }) =>
			get(
				scopedPath(
					`/api/knowledge/entities/${encodeURIComponent(entityId)}/aspects/${encodeURIComponent(aspectId)}/attributes`,
					options.agentId,
					{ kind: "attribute", status: "active", limit: bounded(limit, 50, 200), offset: Math.max(0, Math.floor(offset ?? 0)) },
				),
				"Aspect claims",
			),
	);

	server.registerTool(
		"walk_links",
		{
			title: "Walk dependency links",
			description: "Walk incoming and outgoing dependencies for a stable entity id.",
			inputSchema: z.object({ entityId: z.string(), direction: z.enum(["incoming", "outgoing", "both"]).optional() }),
			annotations: { readOnlyHint: true },
		},
		async ({ entityId, direction }) =>
			get(
				scopedPath(`/api/knowledge/entities/${encodeURIComponent(entityId)}/dependencies`, options.agentId, {
					direction: direction ?? "both",
				}),
				"Dependency walk",
			),
	);

	server.registerTool(
		"get_claim_evidence",
		{
			title: "Get claim evidence",
			description: "Resolve provenance for a scoped claim path.",
			inputSchema: z.object({
				entity: z.string(),
				aspect: z.string(),
				group: z.string(),
				claim: z.string(),
				limit: z.number().optional(),
				offset: z.number().optional(),
			}),
			annotations: { readOnlyHint: true },
		},
		async ({ entity, aspect, group, claim, limit, offset }) =>
			get(
				scopedPath("/api/ontology/claims/evidence", options.agentId, {
					entity,
					aspect,
					group,
					claim,
					limit: bounded(limit, 20, 200),
					offset: Math.max(0, Math.floor(offset ?? 0)),
				}),
				"Claim evidence",
			),
	);

	server.registerTool(
		"get_link_evidence",
		{
			title: "Get link evidence",
			description: "Resolve provenance for a scoped dependency link.",
			inputSchema: z.object({ id: z.string() }),
			annotations: { readOnlyHint: true },
		},
		async ({ id }) => get(scopedPath(`/api/ontology/links/${encodeURIComponent(id)}/evidence`, options.agentId), "Link evidence"),
	);

	server.registerTool(
		"search_evidence",
		{
			title: "Search episodic evidence",
			description: "Search immutable episodic evidence in this Dreaming pass's agent scope.",
			inputSchema: z.object({ query: z.string(), limit: z.number().optional() }),
			annotations: { readOnlyHint: true },
		},
		async ({ query, limit }) => {
			const result = await daemonFetch<unknown>(options.daemonUrl, "/api/memory/recall", {
				method: "POST",
				body: buildRecallRequestBody(query, { agentId: options.agentId, limit: bounded(limit, 10, 100), sourceOnly: true }),
			});
			return result.ok ? textResult(result.data) : errorResult(`Evidence search failed: ${result.error}`);
		},
	);

	server.registerTool(
		"apply_ontology_ops",
		{
			title: "Apply ontology operations",
			description:
				"Apply cited ontology operations through the daemon audit seam. Every citation needs source_ref, source_kind, source_id, and an exact quote.",
			inputSchema: z.object({
				operations: z
					.array(
						z.object({
							operation: z.string(),
							payload: z.object({}).catchall(z.unknown()),
							reason: z.string().optional(),
							evidence: z.array(z.unknown()).optional(),
							confidence: z.number().optional(),
							risk: z.string().nullable().optional(),
						}),
					)
					.min(1)
					.max(100),
			}),
			annotations: { readOnlyHint: false },
		},
		async ({ operations }) => {
			const result = await daemonFetch<unknown>(options.daemonUrl, "/api/dream/operations", {
				method: "POST",
				body: { operations, agentId: options.agentId, actor: "dreaming-acpx" },
			});
			return result.ok ? textResult(result.data) : errorResult(`Dreaming ontology operations failed: ${result.error}`);
		},
	);

	return server;
}

/**
 * MCP tool definitions for the Signet daemon.
 *
 * Creates an McpServer with memory operations exposed as MCP tools.
 * Tool handlers call the daemon's HTTP API — this avoids duplicating
 * the complex recall/remember logic and ensures feature parity.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface McpServerOptions {
	/** Daemon HTTP base URL (default: http://localhost:3850) */
	readonly daemonUrl?: string;
	/** Server version string */
	readonly version?: string;
	/** Register installed marketplace MCP tools as first-class MCP tools */
	readonly enableMarketplaceProxyTools?: boolean;
}

interface MarketplaceRoutedTool {
	readonly id: string;
	readonly serverId: string;
	readonly serverName: string;
	readonly toolName: string;
	readonly description: string;
	readonly readOnly: boolean;
	readonly inputSchema: unknown;
}

interface MarketplaceToolsResponse {
	readonly tools: ReadonlyArray<MarketplaceRoutedTool>;
	readonly servers: ReadonlyArray<unknown>;
	readonly count: number;
}

interface MarketplaceProxyState {
	baseUrl: string;
	enabled: boolean;
	names: Set<string>;
	signature: string;
}

interface DaemonResponse<T> {
	readonly ok: true;
	readonly data: T;
}

interface DaemonError {
	readonly ok: false;
	readonly error: string;
	readonly status: number;
}

type FetchResult<T> = DaemonResponse<T> | DaemonError;

const BASE_TOOL_NAMES = new Set<string>([
	"memory_search",
	"memory_store",
	"memory_get",
	"memory_list",
	"memory_modify",
	"memory_forget",
	"secret_list",
	"secret_exec",
	"mcp_server_list",
	"mcp_server_call",
]);

const marketplaceProxyState = new WeakMap<McpServer, MarketplaceProxyState>();

// ---------------------------------------------------------------------------
// Internal HTTP helper
// ---------------------------------------------------------------------------

async function daemonFetch<T>(
	baseUrl: string,
	path: string,
	options: {
		readonly method?: string;
		readonly body?: unknown;
		readonly timeout?: number;
	} = {},
): Promise<FetchResult<T>> {
	const { method = "GET", body, timeout = 10_000 } = options;

	const init: RequestInit = {
		method,
		headers: {
			"Content-Type": "application/json",
			"x-signet-runtime-path": "plugin",
			"x-signet-actor": "mcp-server",
			"x-signet-actor-type": "harness",
		},
		signal: AbortSignal.timeout(timeout),
	};

	if (body !== undefined) {
		init.body = JSON.stringify(body);
	}

	try {
		const res = await fetch(`${baseUrl}${path}`, init);
		if (!res.ok) {
			const text = await res.text().catch(() => "unknown error");
			return { ok: false, error: text, status: res.status };
		}
		const data = (await res.json()) as T;
		return { ok: true, data };
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		return { ok: false, error: msg, status: 0 };
	}
}

function textResult(value: unknown): { content: Array<{ type: "text"; text: string }> } {
	return {
		content: [
			{
				type: "text" as const,
				text: typeof value === "string" ? value : JSON.stringify(value, null, 2),
			},
		],
	};
}

function errorResult(msg: string): {
	content: Array<{ type: "text"; text: string }>;
	isError: true;
} {
	return {
		content: [{ type: "text" as const, text: msg }],
		isError: true as const,
	};
}

function sanitizeToolSegment(value: string): string {
	const normalized = value
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "_")
		.replace(/^_+|_+$/g, "");
	return normalized.length > 0 ? normalized : "tool";
}

function buildProxyToolName(used: Set<string>, serverId: string, toolName: string): string {
	const base = `signet_${sanitizeToolSegment(serverId)}_${sanitizeToolSegment(toolName)}`;
	if (!used.has(base)) {
		used.add(base);
		return base;
	}

	let suffix = 2;
	while (used.has(`${base}_${suffix}`)) {
		suffix += 1;
	}
	const uniqueName = `${base}_${suffix}`;
	used.add(uniqueName);
	return uniqueName;
}

function getRegisteredToolsMap(server: McpServer): Record<string, unknown> | null {
	const internal = server as unknown as {
		_registeredTools?: Record<string, unknown>;
	};
	return internal._registeredTools ?? null;
}

function buildToolsSignature(tools: ReadonlyArray<MarketplaceRoutedTool>): string {
	return tools
		.map((tool) => `${tool.serverId}:${tool.toolName}:${tool.readOnly ? "ro" : "rw"}`)
		.sort()
		.join("|");
}

export async function refreshMarketplaceProxyTools(
	server: McpServer,
	options?: {
		readonly notify?: boolean;
	},
): Promise<{ changed: boolean; count: number; error?: string }> {
	const state = marketplaceProxyState.get(server);
	if (!state || !state.enabled) {
		return { changed: false, count: 0 };
	}

	const notify = options?.notify ?? true;
	const registeredTools = getRegisteredToolsMap(server);

	const routed = await daemonFetch<MarketplaceToolsResponse>(state.baseUrl, "/api/marketplace/mcp/tools?refresh=1", {
		timeout: 3_000,
	});

	if (!routed.ok) {
		return { changed: false, count: state.names.size, error: routed.error };
	}

	const tools = [...routed.data.tools].sort((a, b) =>
		`${a.serverId}:${a.toolName}`.localeCompare(`${b.serverId}:${b.toolName}`),
	);
	const signature = buildToolsSignature(tools);
	if (signature === state.signature) {
		return { changed: false, count: tools.length };
	}

	if (registeredTools) {
		for (const name of state.names) {
			delete registeredTools[name];
		}
	}

	const usedNames = new Set<string>(BASE_TOOL_NAMES);
	if (registeredTools) {
		for (const name of Object.keys(registeredTools)) {
			usedNames.add(name);
		}
	}

	const nextNames = new Set<string>();

	for (const tool of tools) {
		if (!tool.serverId || !tool.toolName) {
			continue;
		}

		const proxyName = buildProxyToolName(usedNames, tool.serverId, tool.toolName);
		const title = `Signet • ${tool.serverName} • ${tool.toolName}`;
		const description =
			tool.description && tool.description.trim().length > 0
				? tool.description
				: `Proxy tool ${tool.toolName} from MCP server ${tool.serverName}`;

		nextNames.add(proxyName);

		server.registerTool(
			proxyName,
			{
				title,
				description,
				inputSchema: z.object({}).passthrough(),
				annotations: { readOnlyHint: tool.readOnly },
			},
			async (args) => {
				const callResult = await daemonFetch<{
					success: boolean;
					result?: unknown;
					error?: string;
				}>(state.baseUrl, "/api/marketplace/mcp/call", {
					method: "POST",
					body: {
						serverId: tool.serverId,
						toolName: tool.toolName,
						args,
					},
					timeout: 60_000,
				});

				if (!callResult.ok) {
					return errorResult(`Tool server call failed: ${callResult.error}`);
				}

				if (!callResult.data.success) {
					return errorResult(`Tool server call failed: ${callResult.data.error ?? "unknown error"}`);
				}

				return textResult(callResult.data.result ?? { success: true });
			},
		);
	}

	state.names = nextNames;
	state.signature = signature;

	if (notify) {
		try {
			server.sendToolListChanged();
		} catch {
			// ignore notification errors for transports that do not support it yet
		}
	}

	return { changed: true, count: tools.length };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export async function createMcpServer(opts?: McpServerOptions): Promise<McpServer> {
	const baseUrl = opts?.daemonUrl ?? "http://localhost:3850";
	const version = opts?.version ?? "0.1.0";
	const enableMarketplaceProxyTools = opts?.enableMarketplaceProxyTools ?? true;

	const server = new McpServer({
		name: "signet",
		version,
	});

	marketplaceProxyState.set(server, {
		baseUrl,
		enabled: enableMarketplaceProxyTools,
		names: new Set<string>(),
		signature: "",
	});

	// ------------------------------------------------------------------
	// memory_search — hybrid vector + keyword search
	// ------------------------------------------------------------------
	server.registerTool(
		"memory_search",
		{
			title: "Search Memories",
			description: "Search memories using hybrid vector + keyword search",
			inputSchema: z.object({
				query: z.string().describe("Search query text"),
				limit: z.number().optional().describe("Max results to return (default 10)"),
				type: z.string().optional().describe("Filter by memory type"),
				min_score: z.number().optional().describe("Minimum relevance score threshold"),
			}),
		},
		async ({ query, limit, type, min_score }) => {
			const result = await daemonFetch<unknown>(baseUrl, "/api/memory/recall", {
				method: "POST",
				body: {
					query,
					limit: limit ?? 10,
					type,
					importance_min: min_score,
				},
			});

			if (!result.ok) {
				return errorResult(`Search failed: ${result.error}`);
			}
			return textResult(result.data);
		},
	);

	// ------------------------------------------------------------------
	// memory_store — save a new memory
	// ------------------------------------------------------------------
	server.registerTool(
		"memory_store",
		{
			title: "Store Memory",
			description: "Save a new memory",
			inputSchema: z.object({
				content: z.string().describe("Memory content to save"),
				type: z.string().optional().describe("Memory type (fact, preference, decision, etc.)"),
				importance: z.number().optional().describe("Importance score 0-1"),
				tags: z.string().optional().describe("Comma-separated tags for categorization"),
			}),
			annotations: { readOnlyHint: false },
		},
		async ({ content, type, importance, tags }) => {
			// Prepend tags prefix if provided (daemon parses [tag1,tag2]: format)
			let body = content;
			if (tags) {
				body = `[${tags}]: ${content}`;
			}

			const result = await daemonFetch<unknown>(baseUrl, "/api/memory/remember", {
				method: "POST",
				body: {
					content: body,
					importance,
				},
			});

			if (!result.ok) {
				return errorResult(`Store failed: ${result.error}`);
			}
			return textResult(result.data);
		},
	);

	// ------------------------------------------------------------------
	// memory_get — retrieve a memory by ID
	// ------------------------------------------------------------------
	server.registerTool(
		"memory_get",
		{
			title: "Get Memory",
			description: "Get a single memory by its ID",
			inputSchema: z.object({
				id: z.string().describe("Memory ID to retrieve"),
			}),
		},
		async ({ id }) => {
			const result = await daemonFetch<unknown>(baseUrl, `/api/memory/${encodeURIComponent(id)}`);

			if (!result.ok) {
				return errorResult(`Get failed: ${result.error}`);
			}
			return textResult(result.data);
		},
	);

	// ------------------------------------------------------------------
	// memory_list — list memories with optional filters
	// ------------------------------------------------------------------
	server.registerTool(
		"memory_list",
		{
			title: "List Memories",
			description: "List memories with optional filters",
			inputSchema: z.object({
				limit: z.number().optional().describe("Max results (default 100)"),
				offset: z.number().optional().describe("Pagination offset"),
				type: z.string().optional().describe("Filter by memory type"),
			}),
		},
		async ({ limit, offset, type }) => {
			const params = new URLSearchParams();
			if (limit !== undefined) params.set("limit", String(limit));
			if (offset !== undefined) params.set("offset", String(offset));
			if (type !== undefined) params.set("type", type);

			const qs = params.toString();
			const path = `/api/memories${qs ? `?${qs}` : ""}`;
			const result = await daemonFetch<unknown>(baseUrl, path);

			if (!result.ok) {
				return errorResult(`List failed: ${result.error}`);
			}
			return textResult(result.data);
		},
	);

	// ------------------------------------------------------------------
	// memory_modify — edit an existing memory
	// ------------------------------------------------------------------
	server.registerTool(
		"memory_modify",
		{
			title: "Modify Memory",
			description: "Edit an existing memory by ID",
			inputSchema: z.object({
				id: z.string().describe("Memory ID to modify"),
				content: z.string().optional().describe("New content"),
				type: z.string().optional().describe("New type"),
				importance: z.number().optional().describe("New importance"),
				tags: z.string().optional().describe("New tags (comma-separated)"),
				reason: z.string().describe("Why this edit is being made"),
			}),
			annotations: { readOnlyHint: false },
		},
		async ({ id, content, type, importance, tags, reason }) => {
			const result = await daemonFetch<unknown>(baseUrl, `/api/memory/${encodeURIComponent(id)}`, {
				method: "PATCH",
				body: {
					content,
					type,
					importance,
					tags,
					reason,
				},
			});

			if (!result.ok) {
				return errorResult(`Modify failed: ${result.error}`);
			}
			return textResult(result.data);
		},
	);

	// ------------------------------------------------------------------
	// memory_forget — soft-delete a memory
	// ------------------------------------------------------------------
	server.registerTool(
		"memory_forget",
		{
			title: "Forget Memory",
			description: "Soft-delete a memory by ID",
			inputSchema: z.object({
				id: z.string().describe("Memory ID to forget"),
				reason: z.string().describe("Why this memory should be forgotten"),
			}),
			annotations: { readOnlyHint: false },
		},
		async ({ id, reason }) => {
			const result = await daemonFetch<unknown>(baseUrl, `/api/memory/${encodeURIComponent(id)}`, {
				method: "DELETE",
				body: { reason },
			});

			if (!result.ok) {
				return errorResult(`Forget failed: ${result.error}`);
			}
			return textResult(result.data);
		},
	);

	// ------------------------------------------------------------------
	// secret_list — list available secret names
	// ------------------------------------------------------------------
	server.registerTool(
		"secret_list",
		{
			title: "List Secrets",
			description: "List available secret names. Returns names only — raw values are never exposed to agents.",
			inputSchema: z.object({}),
		},
		async () => {
			const result = await daemonFetch<{ secrets: ReadonlyArray<string> }>(baseUrl, "/api/secrets");

			if (!result.ok) {
				return errorResult(`Failed to list secrets: ${result.error}`);
			}
			return textResult(result.data);
		},
	);

	// ------------------------------------------------------------------
	// secret_exec — run a command with secrets injected as env vars
	// ------------------------------------------------------------------
	server.registerTool(
		"secret_exec",
		{
			title: "Execute with Secrets",
			description:
				"Run a shell command with secrets injected as environment variables. " +
				"Provide a secrets map where keys are env var names and values are secret names. " +
				"Output is automatically redacted — secret values never appear in results.",
			inputSchema: z.object({
				command: z.string().describe("Shell command to execute"),
				secrets: z
					.record(z.string(), z.string())
					.describe('Map of env var name → secret name, e.g. { "OPENAI_API_KEY": "OPENAI_API_KEY" }'),
			}),
			annotations: { readOnlyHint: false },
		},
		async ({ command, secrets }) => {
			if (Object.keys(secrets).length === 0) {
				return errorResult("secrets map must contain at least one entry");
			}

			const result = await daemonFetch<{
				stdout: string;
				stderr: string;
				code: number;
			}>(baseUrl, "/api/secrets/exec", {
				method: "POST",
				body: { command, secrets },
				timeout: 30_000,
			});

			if (!result.ok) {
				return errorResult(`Exec failed: ${result.error}`);
			}
			return textResult(result.data);
		},
	);

	// ------------------------------------------------------------------
	// mcp_server_list — list routed marketplace MCP tools
	// ------------------------------------------------------------------
	server.registerTool(
		"mcp_server_list",
		{
			title: "List Tool Servers",
			description: "List installed external Tool Servers (MCP) and discover their routed tools.",
			inputSchema: z.object({
				refresh: z.boolean().optional().describe("Bypass cache and refresh live tool catalogs"),
			}),
		},
		async ({ refresh }) => {
			if (refresh && enableMarketplaceProxyTools) {
				await refreshMarketplaceProxyTools(server, { notify: true });
			}

			const path = refresh ? "/api/marketplace/mcp/tools?refresh=1" : "/api/marketplace/mcp/tools";
			const result = await daemonFetch<{
				count: number;
				tools: unknown[];
				servers: unknown[];
			}>(baseUrl, path);

			if (!result.ok) {
				return errorResult(`Tool server list failed: ${result.error}`);
			}

			return textResult(result.data);
		},
	);

	// ------------------------------------------------------------------
	// mcp_server_call — call a routed marketplace MCP tool
	// ------------------------------------------------------------------
	server.registerTool(
		"mcp_server_call",
		{
			title: "Call Tool Server",
			description:
				"Invoke a routed tool from an installed external Tool Server (MCP). " +
				"Use mcp_server_list first to discover server_id and tool names.",
			inputSchema: z.object({
				server_id: z.string().describe("Installed Tool Server id"),
				tool: z.string().describe("Tool name exposed by that server"),
				args: z.record(z.string(), z.unknown()).optional().describe("Tool argument object"),
			}),
			annotations: { readOnlyHint: false },
		},
		async ({ server_id, tool, args }) => {
			const result = await daemonFetch<{
				success: boolean;
				result?: unknown;
				error?: string;
			}>(baseUrl, "/api/marketplace/mcp/call", {
				method: "POST",
				body: {
					serverId: server_id,
					toolName: tool,
					args: args ?? {},
				},
				timeout: 60_000,
			});

			if (!result.ok) {
				return errorResult(`Tool server call failed: ${result.error}`);
			}

			if (!result.data.success) {
				return errorResult(`Tool server call failed: ${result.data.error ?? "unknown error"}`);
			}

			return textResult(result.data.result ?? { success: true });
		},
	);

	if (enableMarketplaceProxyTools) {
		await refreshMarketplaceProxyTools(server, { notify: false });
	}

	return server;
}

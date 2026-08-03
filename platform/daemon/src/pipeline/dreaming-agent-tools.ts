/** Pi AgentSession binding for the canonical Dreaming capability registry. */
import * as Type from "typebox";
import type { TSchema } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { z } from "zod";
import type { CreateDreamingCapabilitiesParams, DreamingCapabilityResult } from "./dreaming-capabilities";
import { createDreamingCapabilities } from "./dreaming-capabilities";

export type { DreamingAgentEvidence } from "./dreaming-evidence";
export type { DreamingCapabilityResult as DreamingAgentToolResult } from "./dreaming-capabilities";
export type CreateDreamingAgentToolsParams = CreateDreamingCapabilitiesParams;

function textResult(payload: DreamingCapabilityResult): { readonly type: "text"; readonly text: string } {
	return { type: "text", text: JSON.stringify(payload) };
}

/**
 * Bind every registry capability to an isolated Pi session. The schema is
 * generated from the registry's Zod source of truth; invoke performs the
 * same validation again at the daemon boundary before any read or write.
 */
export function createDreamingAgentTools(params: CreateDreamingAgentToolsParams): readonly ToolDefinition<TSchema>[] {
	return createDreamingCapabilities(params).map((capability) => ({
		name: capability.id,
		label: capability.title,
		description: capability.description,
		parameters: Type.Unsafe(z.toJSONSchema(capability.inputSchema)),
		async execute(_toolCallId, rawParams) {
			const result = await capability.invoke(rawParams);
			return { content: [textResult(result)], details: { tool: capability.id } };
		},
	}));
}

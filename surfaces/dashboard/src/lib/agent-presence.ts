export interface AgentPresence {
	readonly sessionKey?: string;
	readonly agentId: string;
	readonly harness: string;
	readonly project?: string;
	readonly runtimePath?: string;
	readonly provider?: string;
	readonly lastSeenAt: string;
}

function normalizeAgentId(agentId: string): string {
	return agentId.trim() || "default";
}

export function buildOwnAgentPresenceUrl(apiBase: string, limit: number, agentId: string): string {
	const params = new URLSearchParams({
		agent_id: normalizeAgentId(agentId),
		include_self: "true",
		limit: String(limit),
	});
	return `${apiBase}/api/cross-agent/presence?${params.toString()}`;
}

export function ownAgentPresence(sessions: readonly AgentPresence[], agentId: string): AgentPresence[] {
	const current = normalizeAgentId(agentId);
	return sessions.filter((session) => session.agentId === current);
}

export function selectLatestOwnPresence(sessions: readonly AgentPresence[], agentId: string): AgentPresence | null {
	const withSeen = ownAgentPresence(sessions, agentId).filter(
		(session) => !Number.isNaN(new Date(session.lastSeenAt).getTime()),
	);
	if (withSeen.length === 0) return null;
	return [...withSeen].sort((a, b) => new Date(b.lastSeenAt).getTime() - new Date(a.lastSeenAt).getTime())[0] ?? null;
}

export async function getOwnAgentPresence(apiBase: string, limit: number, agentId: string): Promise<AgentPresence[]> {
	try {
		const res = await fetch(buildOwnAgentPresenceUrl(apiBase, limit, agentId));
		if (!res.ok) return [];
		const body = (await res.json()) as { sessions?: AgentPresence[] };
		return ownAgentPresence(body.sessions ?? [], agentId);
	} catch {
		return [];
	}
}

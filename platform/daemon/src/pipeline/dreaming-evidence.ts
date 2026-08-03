import type { EpisodicSourceRecord } from "../episodic-sources";

/**
 * Render structured evidence preserved beside an immutable episodic record.
 * This is the canonical text exposed to Dreaming and accepted for citations.
 */
export function renderDreamingEvidenceMeta(evidenceMeta: string | null): string {
	if (!evidenceMeta) return "";
	let parsed: unknown;
	try {
		parsed = JSON.parse(evidenceMeta);
	} catch {
		return "";
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return "";
	const data = parsed as { entities?: unknown[]; aspects?: unknown[] };
	const lines: string[] = [];
	if (Array.isArray(data.entities) && data.entities.length > 0) {
		lines.push("structured_entities:");
		for (const entity of data.entities) {
			if (typeof entity !== "object" || entity === null) continue;
			const value = entity as Record<string, unknown>;
			const source = typeof value.source === "string" ? value.source : "";
			const target = typeof value.target === "string" ? value.target : "";
			const relationship = typeof value.relationship === "string" ? value.relationship : "";
			if (source || target || relationship) {
				lines.push(`- ${source} ${relationship ? `[${relationship}] ` : ""}${target}`.trim());
			}
		}
	}
	if (Array.isArray(data.aspects) && data.aspects.length > 0) {
		lines.push("structured_aspects:");
		for (const aspect of data.aspects) {
			if (typeof aspect !== "object" || aspect === null) continue;
			const value = aspect as Record<string, unknown>;
			const entityName = typeof value.entityName === "string" ? value.entityName : "";
			const aspectName = typeof value.aspect === "string" ? value.aspect : "";
			if (entityName || aspectName) lines.push(`- ${entityName}/${aspectName}`.trim());
		}
	}
	return lines.length > 0 ? `structured_evidence:\n${lines.join("\n")}` : "";
}

/** The complete immutable evidence text Dreaming presents and citation checks. */
export function renderDreamingEvidence(source: EpisodicSourceRecord): string {
	const metadata = renderDreamingEvidenceMeta(source.evidenceMeta);
	return metadata ? `${source.content}\n${metadata}` : source.content;
}

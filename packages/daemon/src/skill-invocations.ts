import { getDbAccessor } from "./db-accessor.js";
import { logger } from "./logger.js";

export type SkillInvocationSource = "agent" | "scheduler" | "api";

export interface SkillInvocationRecord {
	readonly skillName: string;
	readonly agentId: string;
	readonly source: SkillInvocationSource;
	readonly latencyMs: number;
	readonly success: boolean;
	readonly errorText?: string;
}

export function normalizeSkillName(value: string): string {
	return value.trim().toLowerCase();
}

function clampLatency(value: number): number {
	if (!Number.isFinite(value) || value < 0) return 0;
	return Math.round(value);
}

export function recordSkillInvocation(record: SkillInvocationRecord): void {
	const skill = normalizeSkillName(record.skillName);
	if (skill.length === 0) return;
	if (record.agentId.trim().length === 0) return;

	const now = new Date().toISOString();
	const id = crypto.randomUUID();
	const latency = clampLatency(record.latencyMs);

	try {
		getDbAccessor().withWriteTx((db) => {
			db.prepare(
				`INSERT INTO skill_invocations
				 (id, skill_name, agent_id, source, latency_ms, success, error_text, created_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			).run(id, skill, record.agentId, record.source, latency, record.success ? 1 : 0, record.errorText ?? null, now);

			db.prepare(
				`UPDATE skill_meta
				 SET use_count = COALESCE(use_count, 0) + 1,
				     last_used_at = ?,
				     updated_at = ?
				 WHERE agent_id = ?
				   AND entity_id IN (
					   SELECT id FROM entities
					   WHERE agent_id = ? AND lower(name) = ?
				   )`,
			).run(now, now, record.agentId, record.agentId, skill);
		});
	} catch (err) {
		logger.warn("skills", "Failed to record skill invocation", err instanceof Error ? err : undefined);
	}
}

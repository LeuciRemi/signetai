import { randomUUID } from "node:crypto";
import type { DbAccessor, ReadDb, WriteDb } from "../db-accessor";

export const DREAMING_ATTENTION_KINDS = ["review_due", "hygiene", "contested_claim", "evidence_requeue"] as const;
export type DreamingAttentionKind = (typeof DREAMING_ATTENTION_KINDS)[number];

export interface DreamingAttention {
	readonly id: string;
	readonly kind: DreamingAttentionKind;
	readonly subjectRef: string;
	readonly details: Readonly<Record<string, string>>;
	readonly priority: number;
	readonly createdAt: string;
}

export interface DreamingAttentionSnapshot extends DreamingAttention {
	readonly generation: number;
}

function parseDetails(value: string): Readonly<Record<string, string>> {
	try {
		const parsed: unknown = JSON.parse(value);
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
		return Object.fromEntries(
			Object.entries(parsed).flatMap(([key, detail]) =>
				typeof detail === "string" && key.length <= 64 && detail.length <= 1_000 ? [[key, detail]] : [],
			),
		);
	} catch {
		return {};
	}
}

function boundedPriority(priority: number | undefined): number {
	if (!Number.isFinite(priority)) return 0;
	return Math.max(0, Math.min(100, Math.floor(priority ?? 0)));
}

function normalizedSubjectRef(subjectRef: string): string {
	const normalized = subjectRef.trim();
	if (!normalized || normalized.length > 512) {
		throw new Error("Dreaming attention subjectRef must be between 1 and 512 characters");
	}
	return normalized;
}

function normalizedDetails(details: Readonly<Record<string, string>> | undefined): Readonly<Record<string, string>> {
	return Object.fromEntries(
		Object.entries(details ?? {}).flatMap(([key, value]) =>
			typeof value === "string" && key.length <= 64 && value.length <= 1_000 ? [[key, value]] : [],
		),
	);
}

function promptJson(value: unknown): string {
	return JSON.stringify(value).replaceAll("<", "\\u003c").replaceAll(">", "\\u003e").replaceAll("&", "\\u0026");
}

function getDreamingAttentionSnapshotsInDb(db: ReadDb, agentId: string, limit = 20): readonly DreamingAttentionSnapshot[] {
	const boundedLimit = Math.max(1, Math.min(100, Math.floor(limit)));
	return db
		.prepare(
			`SELECT id, kind, subject_ref AS subjectRef, details_json AS detailsJson,
			        priority, created_at AS createdAt, generation
			 FROM dreaming_attention
			 WHERE agent_id = ? AND resolved_at IS NULL
			 ORDER BY priority DESC, created_at ASC, id ASC
			 LIMIT ?`,
		)
		.all(agentId, boundedLimit)
		.map((row) => {
			const typed = row as {
				id: string;
				kind: DreamingAttentionKind;
				subjectRef: string;
				detailsJson: string;
				priority: number;
				createdAt: string;
				generation: number;
			};
			const { detailsJson, ...attention } = typed;
			return { ...attention, details: parseDetails(detailsJson) };
		}) as DreamingAttentionSnapshot[];
}

export function getDreamingAttentionInDb(db: ReadDb, agentId: string, limit = 20): readonly DreamingAttention[] {
	return getDreamingAttentionSnapshotsInDb(db, agentId, limit).map(({ generation: _, ...attention }) => attention);
}

export function getDreamingAttention(
	accessor: DbAccessor,
	agentId: string,
	limit?: number,
): readonly DreamingAttention[] {
	return accessor.withReadDb((db) => getDreamingAttentionInDb(db, agentId, limit));
}

export function getDreamingAttentionSnapshots(
	accessor: DbAccessor,
	agentId: string,
	limit?: number,
): readonly DreamingAttentionSnapshot[] {
	return accessor.withReadDb((db) => getDreamingAttentionSnapshotsInDb(db, agentId, limit));
}

export function enqueueDreamingAttentionInTx(
	db: WriteDb,
	input: {
		readonly agentId: string;
		readonly kind: DreamingAttentionKind;
		readonly subjectRef: string;
		readonly details?: Readonly<Record<string, string>>;
		readonly priority?: number;
	},
): void {
	if (!DREAMING_ATTENTION_KINDS.includes(input.kind)) {
		throw new Error(`Unsupported Dreaming attention kind: ${input.kind}`);
	}
	const subjectRef = normalizedSubjectRef(input.subjectRef);
	const details = JSON.stringify(normalizedDetails(input.details));
	db.prepare(
		`INSERT INTO dreaming_attention
		 (id, agent_id, kind, subject_ref, details_json, priority)
		 VALUES (?, ?, ?, ?, ?, ?)
		 ON CONFLICT(agent_id, kind, subject_ref) DO UPDATE SET
		   details_json = excluded.details_json,
		   priority = MAX(dreaming_attention.priority, excluded.priority),
		   generation = dreaming_attention.generation + 1,
		   resolved_at = NULL,
		   resolved_by_pass_id = NULL`,
	).run(randomUUID(), input.agentId, input.kind, subjectRef, details, boundedPriority(input.priority));
}

export function resolveDreamingAttentionInTx(
	db: WriteDb,
	agentId: string,
	passId: string,
	attention: readonly DreamingAttentionSnapshot[],
): void {
	const statement = db.prepare(
		`UPDATE dreaming_attention
		 SET resolved_at = datetime('now'), resolved_by_pass_id = ?
		 WHERE id = ? AND agent_id = ? AND generation = ? AND resolved_at IS NULL`,
	);
	for (const item of attention) statement.run(passId, item.id, agentId, item.generation);
}

export function renderDreamingAttentionForPrompt(attention: readonly DreamingAttention[]): string {
	if (attention.length === 0) return "";
	return attention
		.map(
			(item) =>
				`- ${promptJson({ kind: item.kind, subjectRef: item.subjectRef, details: item.details, priority: item.priority })}`,
		)
		.join("\n");
}

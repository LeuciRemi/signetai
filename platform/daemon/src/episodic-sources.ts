import type { ReadDb } from "./db-accessor";

/** Immutable evidence available to Dreaming and ontology extraction. */
export type EpisodicSourceKind = "artifact" | "transcript" | "summary";

/** A stable resume point across the merged episodic stores. */
export interface EpisodicCursor {
	readonly capturedAt: string;
	readonly kind: EpisodicSourceKind | null;
	readonly id: string;
}

export interface EpisodicSourceRecord {
	readonly kind: EpisodicSourceKind;
	readonly id: string;
	readonly content: string;
	readonly sourceKind: string;
	readonly sourceId: string;
	readonly sourcePath: string | null;
	readonly project: string | null;
	readonly harness: string | null;
	readonly capturedAt: string;
}

export interface ReadEpisodicSourceOptions {
	readonly agentId: string;
	readonly from: string;
}

const SOURCE_KIND_RANK: Readonly<Record<EpisodicSourceKind, number>> = {
	artifact: 0,
	transcript: 1,
	summary: 2,
};

function cursorPredicate(
	timestampColumn: string,
	idColumn: string,
	kind: EpisodicSourceKind,
	newerThan: string | null,
	cursor: EpisodicCursor | null | undefined,
): { readonly sql: string; readonly args: readonly (string | null)[] } {
	if (cursor) {
		const cursorRank = cursor.kind === null ? -1 : SOURCE_KIND_RANK[cursor.kind];
		const rank = SOURCE_KIND_RANK[kind];
		if (rank > cursorRank) {
			return { sql: `julianday(${timestampColumn}) >= julianday(?)`, args: [cursor.capturedAt] };
		}
		if (rank < cursorRank) {
			return { sql: `julianday(${timestampColumn}) > julianday(?)`, args: [cursor.capturedAt] };
		}
		return {
			sql: `(julianday(${timestampColumn}) > julianday(?) OR (julianday(${timestampColumn}) = julianday(?) AND ${idColumn} > ?))`,
			args: [cursor.capturedAt, cursor.capturedAt, cursor.id],
		};
	}
	return {
		sql: `(? IS NULL OR julianday(${timestampColumn}) > julianday(?))`,
		args: [newerThan, newerThan],
	};
}

function compareEpisodicSources(a: EpisodicSourceRecord, b: EpisodicSourceRecord, order: "newest" | "oldest"): number {
	const time = timestampMillis(a.capturedAt) - timestampMillis(b.capturedAt);
	if (time !== 0) return order === "oldest" ? time : -time;
	const rank = SOURCE_KIND_RANK[a.kind] - SOURCE_KIND_RANK[b.kind];
	if (rank !== 0) return order === "oldest" ? rank : -rank;
	const id = a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
	return order === "oldest" ? id : -id;
}

/** Match SQLite julianday's UTC interpretation of timezone-less timestamps. */
function timestampMillis(value: string): number {
	const normalized = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(value)
		? `${value.replace(" ", "T")}Z`
		: value;
	const parsed = Date.parse(normalized);
	return Number.isFinite(parsed) ? parsed : 0;
}

export function sourceIdCandidates(value: string): string[] {
	const trimmed = value.trim();
	const stripped = trimmed.replace(/^(artifact|source|transcript|session|summary):/, "");
	return [
		...new Set(
			[
				trimmed,
				stripped,
				`artifact:${stripped}`,
				`source:${stripped}`,
				`transcript:${stripped}`,
				`session:${stripped}`,
				`summary:${stripped}`,
			].filter(Boolean),
		),
	];
}

export function readEpisodicArtifact(db: ReadDb, agentId: string, id: string): EpisodicSourceRecord | null {
	const ids = sourceIdCandidates(id);
	const placeholders = ids.map(() => "?").join(", ");
	const row = db
		.prepare(
			`SELECT source_path, source_kind, source_node_id, session_id, session_key, session_token,
			        project, harness, content, captured_at, updated_at
			 FROM memory_artifacts
			 WHERE agent_id = ?
			   AND COALESCE(is_deleted, 0) = 0
			   AND (
			     source_path = ?
			     OR source_node_id IN (${placeholders})
			     OR session_id IN (${placeholders})
			     OR session_key IN (${placeholders})
			     OR session_token IN (${placeholders})
			   )
			 ORDER BY captured_at DESC
			 LIMIT 1`,
		)
		.get(agentId, id, ...ids, ...ids, ...ids, ...ids) as
		| {
				readonly source_path: string;
				readonly source_kind: string;
				readonly source_node_id: string | null;
				readonly session_id: string;
				readonly session_key: string | null;
				readonly session_token: string;
				readonly project: string | null;
				readonly harness: string | null;
				readonly content: string;
				readonly captured_at: string;
				readonly updated_at: string;
		  }
		| undefined;
	if (!row) return null;
	return {
		kind: "artifact",
		id: row.source_path,
		content: row.content,
		sourceKind: row.source_kind,
		sourceId: row.source_node_id ?? row.session_key ?? row.session_id ?? row.session_token,
		sourcePath: row.source_path,
		project: row.project,
		harness: row.harness,
		capturedAt: row.captured_at ?? row.updated_at,
	};
}

export function readEpisodicTranscript(db: ReadDb, agentId: string, id: string): EpisodicSourceRecord | null {
	const ids = sourceIdCandidates(id);
	const placeholders = ids.map(() => "?").join(", ");
	const row = db
		.prepare(
			`SELECT session_key, content, harness, project, created_at, updated_at
			 FROM session_transcripts
			 WHERE agent_id = ? AND session_key IN (${placeholders})
			 ORDER BY updated_at DESC, created_at DESC
			 LIMIT 1`,
		)
		.get(agentId, ...ids) as
		| {
				readonly session_key: string;
				readonly content: string;
				readonly harness: string | null;
				readonly project: string | null;
				readonly created_at: string;
				readonly updated_at: string | null;
		  }
		| undefined;
	if (!row) return null;
	return {
		kind: "transcript",
		id: row.session_key,
		content: row.content,
		sourceKind: "transcript",
		sourceId: row.session_key,
		sourcePath: null,
		project: row.project,
		harness: row.harness,
		capturedAt: row.updated_at ?? row.created_at,
	};
}

export function readEpisodicSummary(db: ReadDb, agentId: string, id: string): EpisodicSourceRecord | null {
	const ids = sourceIdCandidates(id);
	const placeholders = ids.map(() => "?").join(", ");
	// Compaction/checkpoint rows are first-class episodic evidence here. The
	// Dreaming pass intentionally narrows its own LLM input to primary summaries
	// to avoid feeding its derived rollups back into consolidation.
	const row = db
		.prepare(
			`SELECT id, content, project, harness, session_key, source_type, source_ref, latest_at
			 FROM session_summaries
			 WHERE agent_id = ?
			   AND depth = 0
			   AND COALESCE(source_type, 'summary') IN ('summary', 'compaction', 'checkpoint')
			   AND (id IN (${placeholders}) OR source_ref IN (${placeholders}))
			 ORDER BY latest_at DESC
			 LIMIT 1`,
		)
		.get(agentId, ...ids, ...ids) as
		| {
				readonly id: string;
				readonly content: string;
				readonly project: string | null;
				readonly harness: string | null;
				readonly session_key: string | null;
				readonly source_type: string | null;
				readonly source_ref: string | null;
				readonly latest_at: string;
		  }
		| undefined;
	if (!row) return null;
	return {
		kind: "summary",
		id: row.id,
		content: row.content,
		sourceKind: row.source_type ?? "summary",
		sourceId: row.source_ref ?? row.session_key ?? row.id,
		sourcePath: null,
		project: row.project,
		harness: row.harness,
		capturedAt: row.latest_at,
	};
}

/**
 * Read evidence across all current episodic stores.
 *
 * `newerThan` is a captured-artifact watermark, not a mutation cursor: the
 * artifacts themselves remain immutable and selectable after a Dreaming pass.
 */
export function readRecentEpisodicSources(
	db: ReadDb,
	agentId: string,
	limit: number,
	kinds?: readonly EpisodicSourceKind[],
	newerThan?: string | null,
	order: "newest" | "oldest" = "newest",
	cursor?: EpisodicCursor | null,
): EpisodicSourceRecord[] {
	const boundedLimit = Math.max(1, Math.min(Math.floor(limit), 500));
	const newer = newerThan?.trim() || null;
	const direction = order === "oldest" ? "ASC" : "DESC";
	const artifactCursor = cursorPredicate("captured_at", "source_path", "artifact", newer, cursor);
	const transcriptCursor = cursorPredicate(
		"COALESCE(updated_at, created_at)",
		"session_key",
		"transcript",
		newer,
		cursor,
	);
	const summaryCursor = cursorPredicate("latest_at", "id", "summary", newer, cursor);
	const allowedKinds = kinds ? new Set(kinds) : null;
	const wants = (kind: EpisodicSourceKind): boolean => allowedKinds === null || allowedKinds.has(kind);
	const artifacts: EpisodicSourceRecord[] = wants("artifact")
		? db
				.prepare(
					`SELECT source_path, source_kind, source_node_id, session_id, session_key, session_token,
			        project, harness, content, captured_at, updated_at
			 FROM memory_artifacts
			 WHERE agent_id = ? AND COALESCE(is_deleted, 0) = 0
			   AND ${artifactCursor.sql}
			 ORDER BY julianday(captured_at) ${direction}, source_path ${direction}
			 LIMIT ?`,
				)
				.all(agentId, ...artifactCursor.args, boundedLimit)
				.map((row) => {
					const artifact = row as {
						readonly source_path: string;
						readonly source_kind: string;
						readonly source_node_id: string | null;
						readonly session_id: string;
						readonly session_key: string | null;
						readonly session_token: string;
						readonly project: string | null;
						readonly harness: string | null;
						readonly content: string;
						readonly captured_at: string;
						readonly updated_at: string;
					};
					return {
						kind: "artifact",
						id: artifact.source_path,
						content: artifact.content,
						sourceKind: artifact.source_kind,
						sourceId: artifact.source_node_id ?? artifact.session_key ?? artifact.session_id ?? artifact.session_token,
						sourcePath: artifact.source_path,
						project: artifact.project,
						harness: artifact.harness,
						capturedAt: artifact.captured_at ?? artifact.updated_at,
					} satisfies EpisodicSourceRecord;
				})
		: [];
	const transcripts: EpisodicSourceRecord[] = wants("transcript")
		? db
				.prepare(
					`SELECT session_key, content, harness, project, created_at, updated_at
			 FROM session_transcripts
			 WHERE agent_id = ?
			   AND ${transcriptCursor.sql}
			 ORDER BY julianday(COALESCE(updated_at, created_at)) ${direction}, session_key ${direction}
			 LIMIT ?`,
				)
				.all(agentId, ...transcriptCursor.args, boundedLimit)
				.map((row) => {
					const transcript = row as {
						readonly session_key: string;
						readonly content: string;
						readonly harness: string | null;
						readonly project: string | null;
						readonly created_at: string;
						readonly updated_at: string | null;
					};
					return {
						kind: "transcript",
						id: transcript.session_key,
						content: transcript.content,
						sourceKind: "transcript",
						sourceId: transcript.session_key,
						sourcePath: null,
						project: transcript.project,
						harness: transcript.harness,
						capturedAt: transcript.updated_at ?? transcript.created_at,
					} satisfies EpisodicSourceRecord;
				})
		: [];
	const summaries: EpisodicSourceRecord[] = wants("summary")
		? db
				.prepare(
					`SELECT id, content, project, harness, session_key, source_type, source_ref, latest_at
			 FROM session_summaries
			 WHERE agent_id = ?
			   AND depth = 0
			   AND COALESCE(source_type, 'summary') IN ('summary', 'compaction', 'checkpoint')
			   AND ${summaryCursor.sql}
			 ORDER BY julianday(latest_at) ${direction}, id ${direction}
			 LIMIT ?`,
				)
				.all(agentId, ...summaryCursor.args, boundedLimit)
				.map((row) => {
					const summary = row as {
						readonly id: string;
						readonly content: string;
						readonly project: string | null;
						readonly harness: string | null;
						readonly session_key: string | null;
						readonly source_type: string | null;
						readonly source_ref: string | null;
						readonly latest_at: string;
					};
					return {
						kind: "summary",
						id: summary.id,
						content: summary.content,
						sourceKind: summary.source_type ?? "summary",
						sourceId: summary.source_ref ?? summary.session_key ?? summary.id,
						sourcePath: null,
						project: summary.project,
						harness: summary.harness,
						capturedAt: summary.latest_at,
					} satisfies EpisodicSourceRecord;
				})
		: [];
	return [...artifacts, ...transcripts, ...summaries]
		.sort((a, b) => compareEpisodicSources(a, b, order))
		.slice(0, boundedLimit);
}

/** Resolve one episodic record without falling back to semantic memory. */
export function readEpisodicSource(db: ReadDb, options: ReadEpisodicSourceOptions): EpisodicSourceRecord | null {
	const from = options.from.trim();
	if (!from) return null;
	if (from.startsWith("transcript:") || from.startsWith("session:")) {
		return readEpisodicTranscript(db, options.agentId, from);
	}
	if (from.startsWith("summary:")) return readEpisodicSummary(db, options.agentId, from);
	if (from.startsWith("artifact:") || from.startsWith("source:")) {
		return readEpisodicArtifact(db, options.agentId, from.replace(/^(artifact|source):/, ""));
	}
	return (
		readEpisodicArtifact(db, options.agentId, from) ??
		readEpisodicTranscript(db, options.agentId, from) ??
		readEpisodicSummary(db, options.agentId, from)
	);
}

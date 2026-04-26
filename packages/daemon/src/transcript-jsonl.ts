import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { resolveDefaultBasePath } from "@signet/core";

export type TranscriptRole = "user" | "assistant" | "unknown";
export type TranscriptSourceFormat = "jsonl" | "markdown" | "db" | "live" | "normalized";

export interface CanonicalTranscriptRecord {
	readonly schema: "signet.transcript.v1";
	readonly id: string;
	readonly captured_at: string;
	readonly agent_id: string;
	readonly harness: string;
	readonly session_key: string | null;
	readonly session_id: string | null;
	readonly project: string | null;
	readonly seq: number;
	readonly role: TranscriptRole;
	readonly content: string;
	readonly source_format: TranscriptSourceFormat;
	readonly source_path?: string;
	readonly source_sha256: string;
}

export interface TranscriptTurn {
	readonly role: TranscriptRole;
	readonly content: string;
}

interface TranscriptIdentity {
	readonly basePath?: string;
	readonly agentId: string;
	readonly harness: string;
	readonly sessionKey: string | null;
	readonly sessionId?: string | null;
	readonly project?: string | null;
	readonly capturedAt?: string;
	readonly sourceFormat: TranscriptSourceFormat;
	readonly sourcePath?: string;
}

function resolveBasePath(basePath?: string): string {
	return basePath ?? process.env.SIGNET_PATH ?? resolveDefaultBasePath();
}

export function sanitizeHarnessPath(harness: string): string {
	const trimmed = harness.trim().toLowerCase();
	const safe = trimmed.replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
	return safe.length > 0 ? safe : "unknown";
}

export function canonicalTranscriptRelativePath(harness: string): string {
	return `memory/${sanitizeHarnessPath(harness)}/transcripts/transcript.jsonl`;
}

export function canonicalTranscriptPath(basePath: string | undefined, harness: string): string {
	return join(resolveBasePath(basePath), canonicalTranscriptRelativePath(harness));
}

function normalizeLf(text: string): string {
	return text.replace(/\r\n?/g, "\n");
}

function cleanTurnContent(text: string): string {
	return normalizeLf(text).replace(/\s+/g, " ").trim();
}

function sha256(text: string): string {
	return createHash("sha256").update(text, "utf8").digest("hex");
}

function recordId(record: Omit<CanonicalTranscriptRecord, "id">): string {
	return sha256(
		[
			record.schema,
			record.agent_id,
			record.harness,
			record.session_key ?? "",
			record.session_id ?? "",
			String(record.seq),
			record.role,
			record.content,
			record.source_sha256,
		].join("\0"),
	).slice(0, 32);
}

function makeRecord(input: TranscriptIdentity, turn: TranscriptTurn, seq: number): CanonicalTranscriptRecord | null {
	const content = cleanTurnContent(turn.content);
	if (content.length === 0) return null;
	const withoutId = {
		schema: "signet.transcript.v1" as const,
		captured_at: input.capturedAt ?? new Date().toISOString(),
		agent_id: input.agentId.trim() || "default",
		harness: sanitizeHarnessPath(input.harness),
		session_key: input.sessionKey?.trim() || null,
		session_id: input.sessionId?.trim() || input.sessionKey?.trim() || null,
		project: input.project?.trim() || null,
		seq,
		role: turn.role,
		content,
		source_format: input.sourceFormat,
		...(input.sourcePath ? { source_path: input.sourcePath } : {}),
		source_sha256: sha256(content),
	};
	return { ...withoutId, id: recordId(withoutId) };
}

export function transcriptTextToTurns(transcript: string): TranscriptTurn[] {
	const turns: TranscriptTurn[] = [];
	for (const line of normalizeLf(transcript).split("\n")) {
		const trimmed = line.trim();
		if (trimmed.length === 0) continue;
		const match = trimmed.match(/^(User|Human|Assistant)\s*:\s*(.*)$/i);
		if (match) {
			const role = match[1]?.toLowerCase() === "assistant" ? "assistant" : "user";
			turns.push({ role, content: match[2] ?? "" });
			continue;
		}
		turns.push({ role: "unknown", content: trimmed });
	}
	return turns;
}

function readRecords(path: string): CanonicalTranscriptRecord[] {
	if (!existsSync(path)) return [];
	const records: CanonicalTranscriptRecord[] = [];
	for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
		const trimmed = line.trim();
		if (trimmed.length === 0) continue;
		try {
			const parsed = JSON.parse(trimmed) as Partial<CanonicalTranscriptRecord>;
			if (parsed.schema === "signet.transcript.v1" && typeof parsed.content === "string") {
				records.push(parsed as CanonicalTranscriptRecord);
			}
		} catch {
			// Ignore malformed historical lines rather than blocking capture.
		}
	}
	return records;
}

function writeRecords(path: string, records: readonly CanonicalTranscriptRecord[]): void {
	mkdirSync(dirname(path), { recursive: true });
	const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
	const body = records.map((record) => JSON.stringify(record)).join("\n");
	writeFileSync(tmp, body.length > 0 ? `${body}\n` : "", "utf8");
	renameSync(tmp, path);
}

function sameSession(record: CanonicalTranscriptRecord, input: TranscriptIdentity): boolean {
	const sessionKey = input.sessionKey?.trim() || null;
	const sessionId = input.sessionId?.trim() || null;
	if (sessionId !== null) {
		return (
			record.agent_id === (input.agentId.trim() || "default") &&
			record.harness === sanitizeHarnessPath(input.harness) &&
			(record.session_id === sessionId ||
				(sessionKey !== null && record.session_key === sessionKey && record.session_id === sessionKey))
		);
	}
	return (
		record.agent_id === (input.agentId.trim() || "default") &&
		record.harness === sanitizeHarnessPath(input.harness) &&
		sessionKey !== null &&
		record.session_key === sessionKey
	);
}

export function writeCanonicalTranscriptSnapshot(
	input: TranscriptIdentity & { readonly transcript: string },
): string | null {
	const turns = transcriptTextToTurns(input.transcript);
	if (turns.length === 0) return null;
	const path = canonicalTranscriptPath(input.basePath, input.harness);
	const existing = readRecords(path).filter((record) => !sameSession(record, input));
	const next = turns
		.map((turn, index) => makeRecord(input, turn, index + 1))
		.filter((record): record is CanonicalTranscriptRecord => record !== null);
	if (next.length === 0) return null;
	writeRecords(path, [...existing, ...next]);
	return path;
}

export function appendCanonicalTranscriptTurns(
	input: TranscriptIdentity & { readonly turns: readonly TranscriptTurn[] },
): string | null {
	const turns = input.turns.filter((turn) => cleanTurnContent(turn.content).length > 0);
	if (turns.length === 0) return null;
	const path = canonicalTranscriptPath(input.basePath, input.harness);
	const existing = readRecords(path);
	const relevant = existing.filter((record) => sameSession(record, input));
	let seq = relevant.reduce((max, record) => Math.max(max, record.seq), 0);
	const next = turns
		.map((turn) => makeRecord(input, turn, ++seq))
		.filter((record): record is CanonicalTranscriptRecord => record !== null);
	if (next.length === 0) return null;
	writeRecords(path, [...existing, ...next]);
	return path;
}

export function inferTranscriptSourceFormat(raw: string): TranscriptSourceFormat {
	const lines = raw
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean);
	if (lines.length === 0) return "normalized";
	let parsed = 0;
	for (const line of lines) {
		try {
			JSON.parse(line);
			parsed++;
		} catch {
			// not JSON
		}
	}
	return parsed >= Math.ceil(lines.length * 0.6) ? "jsonl" : "markdown";
}

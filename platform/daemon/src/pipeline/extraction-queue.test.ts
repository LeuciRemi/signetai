/**
 * Regression tests for the Dreaming cutover gate in extraction-queue.
 *
 * When `memory.dreaming.enabled` is true, Dreaming owns semantic writes and
 * the legacy extraction workers are not started (see daemon.ts). The shared
 * enqueue functions must therefore refuse to create `extract` jobs so that
 * they do not accumulate as a permanent unleased backlog.
 *
 * Covers every active enqueue surface:
 *   - enqueueExtractionJob (accessor variant; used by routes/state.ts queueExtractionJob)
 *   - enqueueExtractionJobInTx (tx variant; used by aggregate-recall.ts and summary-worker.ts)
 */

import { Database } from "bun:sqlite";
import { rmSync, writeFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { runMigrations } from "../../../core/src/migrations";
import type { DbAccessor, ReadDb, WriteDb } from "../db-accessor";
import {
	dreamingOwnsExtraction,
	enqueueExtractionJob,
	enqueueExtractionJobInTx,
} from "./extraction-queue";

function makeAccessor(db: Database): DbAccessor {
	return {
		withWriteTx<T>(fn: (db: WriteDb) => T): T {
			db.exec("BEGIN IMMEDIATE");
			try {
				const result = fn(db as unknown as WriteDb);
				db.exec("COMMIT");
				return result;
			} catch (err) {
				db.exec("ROLLBACK");
				throw err;
			}
		},
		withReadDb<T>(fn: (db: ReadDb) => T): T {
			return fn(db as unknown as ReadDb);
		},
		close() {
			db.close();
		},
	};
}

function insertMemory(db: Database, id: string, content: string): void {
	const now = new Date().toISOString();
	db.prepare(
		`INSERT INTO memories
		 (id, type, content, normalized_content, content_hash, confidence, importance,
		  created_at, updated_at, updated_by, vector_clock, is_deleted, extraction_status,
		  project, scope, agent_id, visibility, source_type, source_id)
		 VALUES (?, 'fact', ?, ?, NULL, 1.0, 0.5, ?, ?, 'test', '{}', 0, 'none', NULL, NULL, 'default', 'global', 'manual', ?)`,
	).run(id, content, content, now, now, id);
}

function countJobs(db: Database, memoryId: string): number {
	const row = db
		.prepare("SELECT COUNT(*) as cnt FROM memory_jobs WHERE memory_id = ? AND job_type = 'extract'")
		.get(memoryId) as { cnt: number };
	return row.cnt;
}

describe("dreamingOwnsExtraction", () => {
	let dir = "";
	let prevSignetPath: string | undefined;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "signet-extraction-gate-"));
		prevSignetPath = process.env.SIGNET_PATH;
		process.env.SIGNET_PATH = dir;
	});

	afterEach(() => {
		if (prevSignetPath === undefined) {
			Reflect.deleteProperty(process.env as Record<string, string | undefined>, "SIGNET_PATH");
		} else {
			process.env.SIGNET_PATH = prevSignetPath;
		}
		rmSync(dir, { recursive: true, force: true });
	});

	it("returns false when no config is present (legacy pipeline active by default)", () => {
		expect(dreamingOwnsExtraction(dir)).toBe(false);
	});

	it("returns false when dreaming is explicitly disabled", () => {
		writeFileSync(join(dir, "agent.yaml"), "memory:\n  dreaming:\n    enabled: false\n");
		expect(dreamingOwnsExtraction(dir)).toBe(false);
	});

	it("returns true when dreaming is enabled (Dreaming owns semantic writes)", () => {
		writeFileSync(join(dir, "agent.yaml"), "memory:\n  dreaming:\n    enabled: true\n");
		expect(dreamingOwnsExtraction(dir)).toBe(true);
	});
});

describe("enqueueExtractionJob Dreaming cutover gate", () => {
	let db: Database;
	let accessor: DbAccessor;
	let dir = "";
	let prevSignetPath: string | undefined;

	beforeEach(() => {
		db = new Database(":memory:");
		runMigrations(db as unknown as Parameters<typeof runMigrations>[0]);
		accessor = makeAccessor(db);

		dir = mkdtempSync(join(tmpdir(), "signet-extraction-gate-"));
		mkdirSync(join(dir, "memory"), { recursive: true });
		prevSignetPath = process.env.SIGNET_PATH;
		process.env.SIGNET_PATH = dir;
	});

	afterEach(() => {
		db.close();
		if (prevSignetPath === undefined) {
			Reflect.deleteProperty(process.env as Record<string, string | undefined>, "SIGNET_PATH");
		} else {
			process.env.SIGNET_PATH = prevSignetPath;
		}
		rmSync(dir, { recursive: true, force: true });
	});

	it("creates an extract job when dreaming is disabled (legacy pipeline active)", () => {
		insertMemory(db, "mem-legacy", "User prefers dark mode in their IDE setup");
		enqueueExtractionJob(accessor, "mem-legacy");

		expect(countJobs(db, "mem-legacy")).toBe(1);
	});

	it("does not create an extract job when dreaming is enabled (cutover)", () => {
		writeFileSync(join(dir, "agent.yaml"), "memory:\n  dreaming:\n    enabled: true\n");

		insertMemory(db, "mem-dream", "User prefers dark mode in their IDE setup");
		enqueueExtractionJob(accessor, "mem-dream");

		expect(countJobs(db, "mem-dream")).toBe(0);
	});

	it("does not create an extract job via the InTx variant when dreaming is enabled", () => {
		writeFileSync(join(dir, "agent.yaml"), "memory:\n  dreaming:\n    enabled: true\n");

		insertMemory(db, "mem-dream-tx", "User prefers dark mode in their IDE setup");
		accessor.withWriteTx((wdb) => {
			enqueueExtractionJobInTx(wdb, "mem-dream-tx");
		});

		expect(countJobs(db, "mem-dream-tx")).toBe(0);
	});

	it("resumes creating extract jobs after dreaming is disabled (config re-read each call)", () => {
		// Start with dreaming enabled
		writeFileSync(join(dir, "agent.yaml"), "memory:\n  dreaming:\n    enabled: true\n");
		insertMemory(db, "mem-flip", "User prefers dark mode in their IDE setup");
		enqueueExtractionJob(accessor, "mem-flip");
		expect(countJobs(db, "mem-flip")).toBe(0);

		// Operator disables dreaming (legacy workers started again)
		writeFileSync(join(dir, "agent.yaml"), "memory:\n  dreaming:\n    enabled: false\n");
		enqueueExtractionJob(accessor, "mem-flip");
		expect(countJobs(db, "mem-flip")).toBe(1);
	});
});

import Database from "bun:sqlite";
import { beforeEach, describe, expect, it } from "bun:test";
import type { DbAccessor, WriteDb } from "../db-accessor";
import { retireLegacyExtractionJobs } from "./extraction-fallback";

function makeAccessor(db: Database): DbAccessor {
	return {
		withWriteTx<T>(fn: (wdb: WriteDb) => T): T {
			return fn(db as unknown as WriteDb);
		},
		withReadDb<T>(fn: (rdb: Database) => T): T {
			return fn(db);
		},
		close() {
			db.close();
		},
	};
}

describe("legacy extraction retirement", () => {
	let db: Database;
	let accessor: DbAccessor;

	beforeEach(() => {
		db = new Database(":memory:");
		db.exec(`
			CREATE TABLE memories (id TEXT PRIMARY KEY, type TEXT, extraction_status TEXT, memory_kind TEXT, is_deleted INTEGER DEFAULT 0);
			CREATE TABLE memory_jobs (
				id TEXT PRIMARY KEY, memory_id TEXT NOT NULL, job_type TEXT NOT NULL,
				status TEXT NOT NULL, error TEXT, failed_at TEXT, updated_at TEXT NOT NULL
			);
		`);
		accessor = makeAccessor(db);
	});

	it("terminalizes every unfinished retired extraction job without creating replacement work", () => {
		const now = new Date().toISOString();
		db.prepare("INSERT INTO memories (id, extraction_status) VALUES (?, ?)").run("pending-memory", "queued");
		db.prepare("INSERT INTO memories (id, extraction_status) VALUES (?, ?)").run("leased-memory", "queued");
		db.prepare("INSERT INTO memories (id, extraction_status) VALUES (?, ?)").run("failed-memory", "failed");
		db.prepare("INSERT INTO memories (id, type, extraction_status) VALUES (?, ?, ?)").run(
			"summary-projection",
			"session_summary",
			"queued",
		);
		db.prepare("INSERT INTO memories (id, extraction_status, is_deleted) VALUES (?, ?, 1)").run(
			"deleted-memory",
			"queued",
		);
		db.prepare("INSERT INTO memory_jobs (id, memory_id, job_type, status, updated_at) VALUES (?, ?, ?, ?, ?)").run(
			"pending-job",
			"pending-memory",
			"extract",
			"pending",
			now,
		);
		db.prepare("INSERT INTO memory_jobs (id, memory_id, job_type, status, updated_at) VALUES (?, ?, ?, ?, ?)").run(
			"leased-job",
			"leased-memory",
			"extract",
			"leased",
			now,
		);
		db.prepare("INSERT INTO memory_jobs (id, memory_id, job_type, status, updated_at) VALUES (?, ?, ?, ?, ?)").run(
			"summary-job",
			"summary-projection",
			"extract",
			"pending",
			now,
		);
		db.prepare("INSERT INTO memory_jobs (id, memory_id, job_type, status, updated_at) VALUES (?, ?, ?, ?, ?)").run(
			"failed-job",
			"failed-memory",
			"extract",
			"failed",
			now,
		);
		db.prepare("INSERT INTO memory_jobs (id, memory_id, job_type, status, updated_at) VALUES (?, ?, ?, ?, ?)").run(
			"deleted-job",
			"deleted-memory",
			"extract",
			"pending",
			now,
		);

		expect(retireLegacyExtractionJobs(accessor, { reason: "Dreaming owns semantic writes" })).toBe(4);

		const jobs = db.prepare("SELECT id, status FROM memory_jobs ORDER BY id").all();
		expect(jobs).toEqual([
			{ id: "deleted-job", status: "dead" },
			{ id: "failed-job", status: "failed" },
			{ id: "leased-job", status: "dead" },
			{ id: "pending-job", status: "dead" },
			{ id: "summary-job", status: "dead" },
		]);
		expect(db.prepare("SELECT extraction_status FROM memories WHERE id = ?").get("pending-memory")).toEqual({
			extraction_status: "retired",
		});
		expect(db.prepare("SELECT extraction_status FROM memories WHERE id = ?").get("leased-memory")).toEqual({
			extraction_status: "retired",
		});
		expect(db.prepare("SELECT memory_kind FROM memories WHERE id = ?").get("pending-memory")).toEqual({
			memory_kind: "episodic",
		});
		expect(db.prepare("SELECT memory_kind FROM memories WHERE id = ?").get("leased-memory")).toEqual({
			memory_kind: "episodic",
		});
		expect(db.prepare("SELECT memory_kind FROM memories WHERE id = ?").get("deleted-memory")).toEqual({
			memory_kind: null,
		});
		expect(db.prepare("SELECT memory_kind FROM memories WHERE id = ?").get("summary-projection")).toEqual({
			memory_kind: null,
		});
	});
});

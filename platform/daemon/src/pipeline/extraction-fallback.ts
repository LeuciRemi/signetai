import type { DbAccessor, WriteDb } from "../db-accessor";

export interface LegacyExtractionRetirementOptions {
	readonly reason: string;
}

/**
 * Promote every still-live legacy extraction input into the Dreaming cursor,
 * then retire its job. A cutover must never abandon pending work just because
 * the old worker disappeared: the source remains immutable episodic evidence
 * and Dreaming becomes its live consumer. Deleted or missing sources are
 * intentionally terminal because retention/forgetting already withdrew them.
 */
export function retireLegacyExtractionJobs(accessor: DbAccessor, options: LegacyExtractionRetirementOptions): number {
	const now = new Date().toISOString();
	return accessor.withWriteTx((db) => {
		const sources = db
			.prepare(
				`SELECT DISTINCT m.id, m.type, COALESCE(m.is_deleted, 0) AS is_deleted
				 FROM memory_jobs j
				 JOIN memories m ON m.id = j.memory_id
				 WHERE j.job_type = 'extract'
				   AND j.status IN ('pending', 'leased')`,
			)
			.all() as Array<{ id: string; type: string | null; is_deleted: number }>;

		// Existing extraction jobs can predate migration 094. Retain each live
		// source as episodic evidence before retiring the unconsumed job. A
		// session-summary memory is a recall projection, not a raw input; its
		// temporal-DAG node remains the canonical Dreaming source.
		for (const source of sources) {
			if (source.is_deleted !== 0 || source.type === "session_summary") continue;
			db.prepare("UPDATE memories SET memory_kind = 'episodic' WHERE id = ? AND COALESCE(is_deleted, 0) = 0").run(
				source.id,
			);
		}

		const result = db
			.prepare(
				`UPDATE memory_jobs
			 SET status = 'dead', error = ?, failed_at = ?, updated_at = ?
			 WHERE job_type = 'extract'
			   AND status IN ('pending', 'leased')`,
			)
			.run(options.reason, now, now);

		for (const source of sources) {
			db.prepare("UPDATE memories SET extraction_status = 'retired' WHERE id = ?").run(source.id);
		}

		return result.changes;
	});
}

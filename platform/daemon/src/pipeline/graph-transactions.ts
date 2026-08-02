/**
 * Graph entity/relation cleanup for the extraction pipeline.
 *
 * Separated from transactions.ts (which handles memory CRUD) to keep
 * both files under the 700 LOC soft cap.
 *
 * All functions expect to run inside a withWriteTx closure.
 */

import type { WriteDb } from "../db-accessor";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DecrementInput {
	readonly entityIds: readonly string[];
}

export interface DecrementResult {
	readonly entitiesOrphaned: number;
}

// ---------------------------------------------------------------------------
// Exported transaction closures
// ---------------------------------------------------------------------------

/**
 * Decrement entity mention counts after memory purge. Entities that
 * drop to 0 mentions are deleted, and dangling relations are cleaned.
 *
 * Call inside `accessor.withWriteTx(db => txDecrementEntityMentions(db, input))`.
 */
export function txDecrementEntityMentions(db: WriteDb, input: DecrementInput): DecrementResult {
	if (input.entityIds.length === 0) return { entitiesOrphaned: 0 };

	// Decrement mentions (floor at 0)
	for (const entityId of input.entityIds) {
		db.prepare(
			`UPDATE entities
			 SET mentions = MAX(0, mentions - 1)
			 WHERE id = ?`,
		).run(entityId);
	}

	// Delete orphaned entities (mentions = 0)
	const orphaned = db.prepare("SELECT id FROM entities WHERE mentions = 0").all() as Array<{ id: string }>;

	if (orphaned.length > 0) {
		const placeholders = orphaned.map(() => "?").join(", ");
		const ids = orphaned.map((r) => r.id);

		// Clean dangling relations first
		db.prepare(
			`DELETE FROM relations
			 WHERE source_entity_id IN (${placeholders})
			    OR target_entity_id IN (${placeholders})`,
		).run(...ids, ...ids);

		// Clean any remaining mention links
		db.prepare(
			`DELETE FROM memory_entity_mentions
			 WHERE entity_id IN (${placeholders})`,
		).run(...ids);

		// Delete the entities themselves
		db.prepare(`DELETE FROM entities WHERE id IN (${placeholders})`).run(...ids);
	}

	return { entitiesOrphaned: orphaned.length };
}

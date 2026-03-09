/**
 * Migration 027: Backfill NULL canonical_name on entities
 *
 * Migration 005 added the canonical_name column but never backfilled
 * existing rows, leaving them NULL. This causes the upsertEntity
 * lookup (which queries by canonical_name) to miss existing entities,
 * leading to UNIQUE constraint violations on the name column during
 * skill reconciliation and extraction.
 */

import type { MigrationDb } from "./index";

export function up(db: MigrationDb): void {
	db.exec(
		"UPDATE entities SET canonical_name = LOWER(TRIM(name)) WHERE canonical_name IS NULL",
	);
}

import type { WriteDb } from "../db-accessor";
import { countChanges } from "../db-helpers";

export interface StaleLeaseRecovery {
	readonly pending: number;
	readonly dead: number;
	readonly total: number;
}

interface RecoverOpts {
	readonly cutoff: string;
	readonly now: string;
}

const LEASE_EXPIRED = "lease expired before completion";

export function recoverStaleLeases(db: WriteDb, opts: RecoverOpts): StaleLeaseRecovery {
	const dead = countChanges(
		db
			.prepare(
				`UPDATE memory_jobs
				 SET status = 'dead',
				     leased_at = NULL,
				     failed_at = ?,
				     error = COALESCE(error, ?),
				     updated_at = ?
				 WHERE status = 'leased'
				   AND leased_at < ?
				   AND attempts >= max_attempts`,
			)
			.run(opts.now, LEASE_EXPIRED, opts.now, opts.cutoff),
	);

	const pending = countChanges(
		db
			.prepare(
				`UPDATE memory_jobs
				 SET status = 'pending',
				     leased_at = NULL,
				     updated_at = ?
				 WHERE status = 'leased'
				   AND leased_at < ?
				   AND attempts < max_attempts`,
			)
			.run(opts.now, opts.cutoff),
	);

	return {
		pending,
		dead,
		total: pending + dead,
	};
}

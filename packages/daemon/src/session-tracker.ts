/**
 * Session Tracker
 *
 * Lightweight in-memory tracker that ensures exactly one runtime path
 * (plugin or legacy-hook) is active per session. Prevents duplicate
 * capture/recall when both paths are configured.
 *
 * Also tracks per-session bypass state — when bypassed, all hook
 * endpoints return empty no-op responses while MCP tools still work.
 */

import { logger } from "./logger";

export type RuntimePath = "plugin" | "legacy";

export interface SessionInfo {
	readonly key: string;
	readonly runtimePath: RuntimePath;
	readonly claimedAt: string;
	readonly bypassed: boolean;
}

interface SessionClaim {
	readonly runtimePath: RuntimePath;
	readonly claimedAt: string;
	expiresAt: number;
}

type ClaimResult = { readonly ok: true } | { readonly ok: false; readonly claimedBy: RuntimePath };

const STALE_SESSION_MS = 4 * 60 * 60 * 1000; // 4 hours
const CLEANUP_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes

const sessions = new Map<string, SessionClaim>();
const bypassedSessions = new Set<string>();
let cleanupTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Claim a session for a given runtime path. Returns ok:true if the
 * session is unclaimed or already claimed by the same path. Returns
 * ok:false with claimedBy if claimed by the other path.
 */
export function claimSession(sessionKey: string, runtimePath: RuntimePath): ClaimResult {
	const existing = sessions.get(sessionKey);

	if (existing) {
		if (existing.runtimePath === runtimePath) {
			// Same path reclaiming — refresh expiry
			existing.expiresAt = Date.now() + STALE_SESSION_MS;
			return { ok: true };
		}

		// Check if the existing claim is stale
		if (Date.now() > existing.expiresAt) {
			logger.info("session-tracker", "Evicting stale session claim", {
				sessionKey,
				previousPath: existing.runtimePath,
				newPath: runtimePath,
			});
			sessions.delete(sessionKey);
			// Fall through to create new claim
		} else {
			return { ok: false, claimedBy: existing.runtimePath };
		}
	}

	sessions.set(sessionKey, {
		runtimePath,
		claimedAt: new Date().toISOString(),
		expiresAt: Date.now() + STALE_SESSION_MS,
	});

	logger.info("session-tracker", "Session claimed", {
		sessionKey,
		runtimePath,
	});

	return { ok: true };
}

/**
 * Release a session claim. Called on session-end.
 * Also cleans up bypass state for the session.
 */
export function releaseSession(sessionKey: string): void {
	const removed = sessions.delete(sessionKey);
	bypassedSessions.delete(sessionKey);
	if (removed) {
		logger.info("session-tracker", "Session released", { sessionKey });
	}
}

/**
 * Return true if the session is currently claimed and not stale.
 * Used by hooks to detect daemon-restart mid-session.
 */
export function hasSession(sessionKey: string): boolean {
	const claim = sessions.get(sessionKey);
	if (!claim) return false;
	if (Date.now() > claim.expiresAt) {
		sessions.delete(sessionKey);
		bypassedSessions.delete(sessionKey);
		return false;
	}
	return true;
}

/**
 * Get the runtime path for a session, if claimed.
 */
export function getSessionPath(sessionKey: string): RuntimePath | undefined {
	const claim = sessions.get(sessionKey);
	if (!claim) return undefined;

	if (Date.now() > claim.expiresAt) {
		sessions.delete(sessionKey);
		bypassedSessions.delete(sessionKey);
		return undefined;
	}

	return claim.runtimePath;
}

// ---------------------------------------------------------------------------
// Bypass state
// ---------------------------------------------------------------------------

/** Enable bypass for a session — hooks return empty no-op responses. */
export function bypassSession(sessionKey: string): boolean {
	if (!sessions.has(sessionKey)) {
		logger.warn("session-tracker", "Bypass requested for unknown session", { sessionKey });
		return false;
	}
	bypassedSessions.add(sessionKey);
	logger.info("session-tracker", "Session bypassed", { sessionKey });
	return true;
}

/** Disable bypass for a session — hooks resume normal behavior. */
export function unbypassSession(sessionKey: string): void {
	const removed = bypassedSessions.delete(sessionKey);
	if (removed) {
		logger.info("session-tracker", "Session bypass removed", { sessionKey });
	}
}

/** Check whether a session is currently bypassed. */
export function isSessionBypassed(sessionKey: string): boolean {
	return bypassedSessions.has(sessionKey);
}

/** Get the set of all bypassed session keys. */
export function getBypassedSessionKeys(): ReadonlySet<string> {
	return bypassedSessions;
}

/** List all active sessions with full state. */
export function getActiveSessions(): readonly SessionInfo[] {
	const now = Date.now();
	const result: SessionInfo[] = [];

	for (const [key, claim] of sessions) {
		if (now > claim.expiresAt) {
			sessions.delete(key);
			bypassedSessions.delete(key);
			continue;
		}
		result.push({
			key,
			runtimePath: claim.runtimePath,
			claimedAt: claim.claimedAt,
			bypassed: bypassedSessions.has(key),
		});
	}

	return result;
}

/**
 * Remove expired session claims.
 */
function cleanupStaleSessions(): void {
	const now = Date.now();
	let cleaned = 0;

	for (const [key, claim] of sessions) {
		if (now > claim.expiresAt) {
			sessions.delete(key);
			bypassedSessions.delete(key);
			cleaned++;
		}
	}

	if (cleaned > 0) {
		logger.info("session-tracker", "Cleaned stale sessions", {
			cleaned,
			remaining: sessions.size,
		});
	}
}

/** Start periodic stale-session cleanup. */
export function startSessionCleanup(): void {
	if (cleanupTimer) return;
	cleanupTimer = setInterval(cleanupStaleSessions, CLEANUP_INTERVAL_MS);
}

/** Stop periodic cleanup (for graceful shutdown). */
export function stopSessionCleanup(): void {
	if (cleanupTimer) {
		clearInterval(cleanupTimer);
		cleanupTimer = null;
	}
}

/** Number of active sessions (for diagnostics). */
export function activeSessionCount(): number {
	return sessions.size;
}

/** Reset all sessions (for testing). */
export function resetSessions(): void {
	sessions.clear();
	bypassedSessions.clear();
}

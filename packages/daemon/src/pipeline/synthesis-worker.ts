/**
 * Synthesis worker: periodic MEMORY.md regeneration.
 *
 * Reads the synthesis schedule from agent.yaml, calls the daemon's own
 * LLM provider to summarize recent memories, and writes the result to
 * MEMORY.md via the existing synthesis-complete logic.
 *
 * This closes the loop that previously required an external harness
 * (OpenClaw, Claude Code) to drive the two-step synthesis hook.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { type MemorySynthesisConfig, getSynthesisConfig, handleSynthesisRequest } from "../hooks";
import { getLlmProvider } from "../llm";
import { logger } from "../logger";
import { generateWithTracking } from "./provider";

const AGENTS_DIR = join(homedir(), ".agents");

// ---------------------------------------------------------------------------
// Schedule helpers
// ---------------------------------------------------------------------------

const SCHEDULE_INTERVALS: Record<string, number> = {
	daily: 24 * 60 * 60 * 1000,
	weekly: 7 * 24 * 60 * 60 * 1000,
};

/** Check interval — how often we check if synthesis is due (5 min). */
const CHECK_INTERVAL_MS = 5 * 60 * 1000;

/** Minimum time between syntheses to avoid rapid re-runs (1 hour). */
const MIN_INTERVAL_MS = 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Timestamp persistence
// ---------------------------------------------------------------------------

function getLastSynthesisPath(): string {
	return join(AGENTS_DIR, ".daemon", "last-synthesis.json");
}

function readLastSynthesisTime(): number {
	try {
		const path = getLastSynthesisPath();
		if (!existsSync(path)) return 0;
		const data = JSON.parse(readFileSync(path, "utf-8"));
		return typeof data.lastRunAt === "number" ? data.lastRunAt : 0;
	} catch {
		return 0;
	}
}

function writeLastSynthesisTime(timestamp: number): void {
	try {
		const path = getLastSynthesisPath();
		mkdirSync(join(AGENTS_DIR, ".daemon"), { recursive: true });
		writeFileSync(path, JSON.stringify({ lastRunAt: timestamp }));
	} catch (e) {
		logger.warn("synthesis", "Failed to persist synthesis timestamp", {
			error: (e as Error).message,
		});
	}
}

// ---------------------------------------------------------------------------
// Core synthesis execution
// ---------------------------------------------------------------------------

async function runSynthesis(config: MemorySynthesisConfig): Promise<boolean> {
	logger.info("synthesis", "Starting scheduled synthesis", {
		model: config.model,
		schedule: config.schedule,
	});

	try {
		// Step 1: Get the synthesis prompt with memories
		const synthesisData = handleSynthesisRequest({ trigger: "scheduled" });

		if (synthesisData.memories.length === 0) {
			logger.info("synthesis", "No memories to synthesize, skipping");
			return true;
		}

		// Step 2: Call LLM to generate the summary
		const provider = getLlmProvider();
		const result = await generateWithTracking(provider, synthesisData.prompt, {
			maxTokens: config.max_tokens ?? 4000,
			timeoutMs: 120_000,
		});

		if (!result.text || result.text.trim().length === 0) {
			logger.warn("synthesis", "LLM returned empty synthesis");
			return false;
		}

		// Step 3: Write MEMORY.md (same logic as synthesis-complete endpoint)
		const memoryMdPath = join(AGENTS_DIR, "MEMORY.md");

		// Backup existing
		if (existsSync(memoryMdPath)) {
			const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
			const backupPath = join(AGENTS_DIR, "memory", `MEMORY.backup-${timestamp}.md`);
			mkdirSync(join(AGENTS_DIR, "memory"), { recursive: true });
			writeFileSync(backupPath, readFileSync(memoryMdPath, "utf-8"));
		}

		// Write new MEMORY.md
		const header = `<!-- generated ${new Date().toISOString().slice(0, 16).replace("T", " ")} -->\n\n`;
		writeFileSync(memoryMdPath, header + result.text);

		logger.info("synthesis", "MEMORY.md synthesized", {
			memories: synthesisData.memories.length,
			outputLength: result.text.length,
			...(result.usage
				? {
						inputTokens: result.usage.inputTokens,
						outputTokens: result.usage.outputTokens,
					}
				: {}),
		});

		return true;
	} catch (e) {
		logger.error("synthesis", "Synthesis failed", e as Error);
		return false;
	}
}

// ---------------------------------------------------------------------------
// Worker handle
// ---------------------------------------------------------------------------

export interface SynthesisWorkerHandle {
	stop(): void;
	readonly running: boolean;
	/** Trigger an immediate synthesis (e.g. from API). */
	triggerNow(): Promise<boolean>;
}

export function startSynthesisWorker(): SynthesisWorkerHandle {
	let timer: ReturnType<typeof setTimeout> | null = null;
	let stopped = false;

	async function tick(): Promise<void> {
		if (stopped) return;

		try {
			const config = getSynthesisConfig();

			// "on-demand" means never auto-run
			if (config.schedule === "on-demand") {
				scheduleTick(CHECK_INTERVAL_MS);
				return;
			}

			const interval = SCHEDULE_INTERVALS[config.schedule] ?? SCHEDULE_INTERVALS.daily;
			const lastRun = readLastSynthesisTime();
			const elapsed = Date.now() - lastRun;

			if (elapsed < interval) {
				// Not due yet
				scheduleTick(CHECK_INTERVAL_MS);
				return;
			}

			const success = await runSynthesis(config);
			if (success) {
				writeLastSynthesisTime(Date.now());
			}
		} catch (e) {
			logger.error("synthesis", "Unhandled tick error", e as Error);
		}

		scheduleTick(CHECK_INTERVAL_MS);
	}

	function scheduleTick(delay: number): void {
		if (stopped) return;
		timer = setTimeout(() => {
			tick().catch((err) => {
				logger.error("synthesis", "Unhandled tick error", err as Error);
			});
		}, delay);
	}

	// Initial delay: 60s after daemon start to let other workers settle
	scheduleTick(60_000);

	logger.info("synthesis", "Synthesis worker started");

	return {
		stop() {
			stopped = true;
			if (timer) clearTimeout(timer);
			logger.info("synthesis", "Synthesis worker stopped");
		},
		get running() {
			return !stopped;
		},
		async triggerNow(): Promise<boolean> {
			const config = getSynthesisConfig();
			const lastRun = readLastSynthesisTime();
			const elapsed = Date.now() - lastRun;

			if (elapsed < MIN_INTERVAL_MS) {
				logger.info("synthesis", "Skipping manual trigger — too recent", {
					elapsedMs: elapsed,
					minIntervalMs: MIN_INTERVAL_MS,
				});
				return false;
			}

			const success = await runSynthesis(config);
			if (success) {
				writeLastSynthesisTime(Date.now());
			}
			return success;
		},
	};
}

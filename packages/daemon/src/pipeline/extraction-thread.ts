/**
 * Worker thread entry point for the extraction pipeline.
 *
 * Runs inside a node:worker_threads Worker. Self-initializes from
 * WorkerInit passed via workerData:
 *   1. Opens own bun:sqlite connection via initDbAccessorLite()
 *   2. Creates own inference router from agentsDir config files
 *   3. Calls startWorker() with a LogSink that forwards to main via IPC
 *   4. Listens for stop/nudge control messages from main thread
 *   5. Forwards stats periodically
 */

import { isMainThread, parentPort, workerData } from "node:worker_threads";
import { getDbAccessor } from "../db-accessor";
import { initDbAccessorLite } from "../db-accessor";
import { fetchEmbedding } from "../embedding-fetch";
import { getOrCreateInferenceRouter } from "../inference-router";
import { getInferenceProvider, initInferenceProviderResolver } from "../llm";
import type { PipelineV2Config, EmbeddingConfig, MemorySearchConfig } from "../memory-config";
import type { DecisionConfig } from "./decision";
import type { MainToWorkerMessage, WorkerInit, WorkerToMainMessage } from "./extraction-thread-protocol";
import type { LogSink } from "./worker";
import { startWorker } from "./worker";

// ---------------------------------------------------------------------------
// Guard: must run as a worker thread
// ---------------------------------------------------------------------------

if (isMainThread) {
	throw new Error("extraction-thread.ts must be loaded as a worker thread");
}

const port = parentPort;
if (!port) throw new Error("parentPort unavailable");
const init = workerData as WorkerInit;

// ---------------------------------------------------------------------------
// IPC helpers
// ---------------------------------------------------------------------------

function send(msg: WorkerToMainMessage): void {
	port!.postMessage(msg);
}

// ---------------------------------------------------------------------------
// LogSink that forwards to main thread via IPC
// ---------------------------------------------------------------------------

const ipcLog: LogSink = {
	info(category: string, message: string, data?: Record<string, unknown>): void {
		send({ type: "log", level: "info", category, message, data });
	},
	warn(category: string, message: string, data?: Record<string, unknown>): void {
		send({ type: "log", level: "warn", category, message, data });
	},
	error(category: string, message: string, error?: Error | unknown, data?: Record<string, unknown>): void {
		const errStr = error instanceof Error ? error.message : error !== undefined ? String(error) : undefined;
		const merged = errStr ? { ...data, errorMessage: errStr } : data;
		send({ type: "log", level: "error", category, message, data: merged });
	},
};

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

const STATS_INTERVAL_MS = 10_000;

async function bootstrap(): Promise<void> {
	try {
		// 1. Init DB — opens own bun:sqlite WAL connection
		initDbAccessorLite(init.dbPath, init.vecExtensionPath);
		const accessor = getDbAccessor();

		// 2. Create LLM provider via inference router
		//    Mirrors daemon.ts:1069-1086 — reads inference.yaml from agentsDir
		const router = getOrCreateInferenceRouter(init.agentsDir);
		initInferenceProviderResolver((workload) => {
			switch (workload) {
				case "memoryExtraction":
					return router.createWorkloadProvider("memory_extraction", init.agentId);
				default:
					return router.createWorkloadProvider("default", init.agentId);
			}
		});
		const provider = getInferenceProvider("memoryExtraction");

		// 3. Reconstruct typed configs from serialized workerData
		const pipelineCfg = init.pipelineConfig as unknown as PipelineV2Config;
		const embeddingCfg = init.embeddingConfig as unknown as EmbeddingConfig;
		const searchCfg = init.searchConfig as unknown as MemorySearchConfig;

		const decisionCfg: DecisionConfig = {
			embedding: embeddingCfg,
			search: searchCfg,
			timeoutMs: pipelineCfg.extraction.timeout,
			fetchEmbedding: (text: string, cfg: EmbeddingConfig) => fetchEmbedding(text, cfg),
		};

		// 4. Start extraction worker
		//    Analytics and telemetry are omitted — the main-thread adapter
		//    can record its own metrics based on IPC stats messages.
		const handle = startWorker(
			accessor,
			provider,
			pipelineCfg,
			decisionCfg,
			undefined,
			undefined,
			undefined,
			ipcLog,
		);

		// 5. Forward stats periodically
		const statsTimer = setInterval(() => {
			send({ type: "stats", stats: handle.stats });
		}, STATS_INTERVAL_MS);

		// 6. Listen for control messages from main thread
		port!.on("message", async (msg: MainToWorkerMessage) => {
			if (msg.type === "stop") {
				clearInterval(statsTimer);
				await handle.stop();
				send({ type: "stopped" });
			} else if (msg.type === "nudge") {
				handle.nudge();
			}
		});

		// 7. Signal ready
		send({ type: "ready" });
	} catch (err) {
		const error = err instanceof Error ? err : new Error(String(err));
		send({ type: "error", error: error.message, stack: error.stack });
		process.exit(1);
	}
}

bootstrap();

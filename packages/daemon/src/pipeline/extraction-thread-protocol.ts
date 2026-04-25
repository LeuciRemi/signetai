/**
 * IPC protocol for the extraction worker thread.
 *
 * Main thread spawns a node:worker_threads Worker with WorkerInit as
 * workerData. Communication uses postMessage only — no MessageChannel,
 * BroadcastChannel, or receiveMessageOnPort.
 */

import type { WorkerStats } from "./worker";

// ---------------------------------------------------------------------------
// Serializable init config (passed via workerData)
// ---------------------------------------------------------------------------

/**
 * Embedding config that can cross the thread boundary.
 * Subset of EmbeddingConfig — only serializable fields.
 */
export interface SerializedEmbeddingConfig {
	readonly provider: string;
	readonly model: string;
	readonly dimensions: number;
	readonly base_url?: string;
	readonly api_key?: string;
}

/** Everything the worker thread needs to self-initialize. */
export interface WorkerInit {
	readonly dbPath: string;
	readonly vecExtensionPath: string;
	/** Agents directory — worker creates its own inference router from config files here. */
	readonly agentsDir: string;
	readonly agentId: string;
	readonly embeddingConfig: SerializedEmbeddingConfig;
	/** Full pipeline config — already a plain object, fully serializable. */
	readonly pipelineConfig: Record<string, unknown>;
	/** Search config for decision phase. */
	readonly searchConfig: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Main → Worker messages
// ---------------------------------------------------------------------------

export type MainToWorkerMessage =
	| { readonly type: "stop" }
	| { readonly type: "nudge" };

// ---------------------------------------------------------------------------
// Worker → Main messages
// ---------------------------------------------------------------------------

export type WorkerToMainMessage =
	| { readonly type: "ready" }
	| { readonly type: "stopped" }
	| { readonly type: "stats"; readonly stats: WorkerStats }
	| { readonly type: "log"; readonly level: string; readonly category: string; readonly message: string; readonly data?: Record<string, unknown> }
	| { readonly type: "telemetry"; readonly event: string; readonly data: Record<string, unknown> }
	| { readonly type: "analytics"; readonly method: string; readonly args: readonly unknown[] }
	| { readonly type: "error"; readonly error: string; readonly stack?: string };

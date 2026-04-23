import { describe, expect, it } from "bun:test";
import type {
	MainToWorkerMessage,
	SerializedEmbeddingConfig,
	WorkerInit,
	WorkerToMainMessage,
} from "../pipeline/extraction-thread-protocol";
import type { LogSink, WorkerStats } from "../pipeline/worker";

describe("extraction-thread-protocol", () => {
	describe("MainToWorkerMessage", () => {
		it("accepts stop message", () => {
			const msg: MainToWorkerMessage = { type: "stop" };
			expect(msg.type).toBe("stop");
		});

		it("accepts nudge message", () => {
			const msg: MainToWorkerMessage = { type: "nudge" };
			expect(msg.type).toBe("nudge");
		});
	});

	describe("WorkerToMainMessage", () => {
		it("accepts ready message", () => {
			const msg: WorkerToMainMessage = { type: "ready" };
			expect(msg.type).toBe("ready");
		});

		it("accepts stopped message", () => {
			const msg: WorkerToMainMessage = { type: "stopped" };
			expect(msg.type).toBe("stopped");
		});

		it("accepts stats message with WorkerStats", () => {
			const stats: WorkerStats = {
				failures: 0,
				lastProgressAt: Date.now(),
				pending: 5,
				processed: 100,
				backoffMs: 0,
				overloaded: false,
				loadPerCpu: 0.5,
				maxLoadPerCpu: 2.0,
				overloadBackoffMs: 1000,
				overloadSince: null,
				nextTickInMs: 100,
			};
			const msg: WorkerToMainMessage = { type: "stats", stats };
			expect(msg.type).toBe("stats");
			expect(msg.stats.processed).toBe(100);
		});

		it("accepts log message with all fields", () => {
			const msg: WorkerToMainMessage = {
				type: "log",
				level: "info",
				category: "extraction",
				message: "Processing started",
				data: { jobId: "123" },
			};
			expect(msg.type).toBe("log");
			expect(msg.level).toBe("info");
			expect(msg.category).toBe("extraction");
		});

		it("accepts log message without data", () => {
			const msg: WorkerToMainMessage = {
				type: "log",
				level: "warn",
				category: "decision",
				message: "Low confidence",
			};
			expect(msg.type).toBe("log");
			expect(msg.data).toBeUndefined();
		});

		it("accepts telemetry message", () => {
			const msg: WorkerToMainMessage = {
				type: "telemetry",
				event: "extraction_complete",
				data: { duration: 150 },
			};
			expect(msg.type).toBe("telemetry");
		});

		it("accepts analytics message", () => {
			const msg: WorkerToMainMessage = {
				type: "analytics",
				method: "track",
				args: ["event_name", { prop: "value" }],
			};
			expect(msg.type).toBe("analytics");
		});

		it("accepts error message with stack", () => {
			const msg: WorkerToMainMessage = {
				type: "error",
				error: "Database connection failed",
				stack: "Error: at worker.ts:123",
			};
			expect(msg.type).toBe("error");
			expect(msg.stack).toBeDefined();
		});

		it("accepts error message without stack", () => {
			const msg: WorkerToMainMessage = {
				type: "error",
				error: "Unknown error",
			};
			expect(msg.type).toBe("error");
			expect(msg.stack).toBeUndefined();
		});
	});

	describe("WorkerInit", () => {
		it("accepts valid WorkerInit with all required fields", () => {
			const embeddingConfig: SerializedEmbeddingConfig = {
				provider: "ollama",
				model: "nomic-embed-text",
				dimensions: 768,
				baseUrl: "http://localhost:11434",
			};

			const init: WorkerInit = {
				dbPath: "/path/to/db.sqlite",
				vecExtensionPath: "/path/to/vec.so",
				agentsDir: "/home/user/.agents",
				agentId: "default",
				embeddingConfig,
				pipelineConfig: { mode: "normal" },
				searchConfig: { limit: 10 },
			};

			expect(init.dbPath).toBe("/path/to/db.sqlite");
			expect(init.agentId).toBe("default");
			expect(init.embeddingConfig.model).toBe("nomic-embed-text");
		});

		it("accepts WorkerInit with optional apiKey in embedding config", () => {
			const embeddingConfig: SerializedEmbeddingConfig = {
				provider: "openai",
				model: "text-embedding-3-small",
				dimensions: 1536,
				apiKey: "sk-...",
			};

			const init: WorkerInit = {
				dbPath: "/path/to/db.sqlite",
				vecExtensionPath: "/path/to/vec.so",
				agentsDir: "/home/user/.agents",
				agentId: "alice",
				embeddingConfig,
				pipelineConfig: {},
				searchConfig: {},
			};

			expect(init.embeddingConfig.apiKey).toBe("sk-...");
		});
	});
});

describe("worker LogSink injection", () => {
	it("accepts LogSink interface with all methods", () => {
		const sink: LogSink = {
			info: (category: string, message: string, data?: Record<string, unknown>) => {
				void category;
				void message;
				void data;
			},
			warn: (category: string, message: string, data?: Record<string, unknown>) => {
				void category;
				void message;
				void data;
			},
			error: (category: string, message: string, error?: Error | unknown, data?: Record<string, unknown>) => {
				void category;
				void message;
				void error;
				void data;
			},
		};

		expect(sink).toBeDefined();
		expect(typeof sink.info).toBe("function");
		expect(typeof sink.warn).toBe("function");
		expect(typeof sink.error).toBe("function");
	});

	it("LogSink can be called with all parameter combinations", () => {
		const calls: Array<{ method: string; args: unknown[] }> = [];

		const sink: LogSink = {
			info: (category, message, data) => {
				calls.push({ method: "info", args: [category, message, data] });
			},
			warn: (category, message, data) => {
				calls.push({ method: "warn", args: [category, message, data] });
			},
			error: (category, message, error, data) => {
				calls.push({ method: "error", args: [category, message, error, data] });
			},
		};

		sink.info("test", "message");
		sink.info("test", "message", { key: "value" });
		sink.warn("test", "warning");
		sink.error("test", "error");
		sink.error("test", "error", new Error("test"), { context: "data" });

		expect(calls).toHaveLength(5);
		expect(calls[0].method).toBe("info");
		expect(calls[1].method).toBe("info");
		expect(calls[2].method).toBe("warn");
		expect(calls[3].method).toBe("error");
		expect(calls[4].method).toBe("error");
	});
});

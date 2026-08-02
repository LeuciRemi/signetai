import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Hono } from "hono";

let app: Hono;
let dir = "";
let prev: string | undefined;
let countConnectorsActive: (connectors: readonly { readonly status: string }[]) => number;
const originalSpawn = Bun.spawn;
const originalWhich = Bun.which;

function streamFromString(value: string): ReadableStream<Uint8Array> {
	return new ReadableStream({
		start(controller) {
			controller.enqueue(new TextEncoder().encode(value));
			controller.close();
		},
	});
}

describe("daemon status contract", () => {
	beforeAll(async () => {
		prev = process.env.SIGNET_PATH;
		dir = mkdtempSync(join(tmpdir(), "signet-daemon-status-"));
		mkdirSync(join(dir, "memory"), { recursive: true });
		writeFileSync(
			join(dir, "agent.yaml"),
			`memory:
  pipelineV2:
    enabled: true
`,
		);
		process.env.SIGNET_PATH = dir;

		const daemon = await import("./daemon");
		const { initDbAccessor } = await import("./db-accessor");
		const state = await import("./routes/state.js");
		initDbAccessor(join(dir, "memory", "memories.db"), { agentsDir: dir });
		state.reloadAuthState(dir);
		app = daemon.app;
		countConnectorsActive = daemon.countConnectorsActive;
	});

	afterAll(async () => {
		try {
			const { closeDbAccessor } = await import("./db-accessor");
			const daemon = await import("./daemon");
			await daemon.stopDaemonRuntimeForTests();
			closeDbAccessor();
		} catch {}
		if (prev === undefined) {
			Reflect.deleteProperty(process.env, "SIGNET_PATH");
		}
		if (prev !== undefined) process.env.SIGNET_PATH = prev;
		rmSync(dir, { recursive: true, force: true });
	});

	afterEach(async () => {
		Bun.spawn = originalSpawn;
		Bun.which = originalWhich;
		const provider = await import("./pipeline/provider");
		provider.configureLlmConcurrency(2);
	});

	it("exposes extraction worker load-shedding fields on /api/status", async () => {
		const res = await app.request("http://localhost/api/status");
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			pipeline?: {
				extraction?: {
					running?: unknown;
					overloaded?: unknown;
					loadPerCpu?: unknown;
					maxLoadPerCpu?: unknown;
					overloadBackoffMs?: unknown;
					overloadSince?: unknown;
					nextTickInMs?: unknown;
				};
			};
		};
		const extraction = body.pipeline?.extraction;
		expect(typeof extraction?.running).toBe("boolean");
		expect(typeof extraction?.overloaded).toBe("boolean");
		expect(extraction).toHaveProperty("maxLoadPerCpu");
		expect(extraction).toHaveProperty("overloadBackoffMs");
		expect(extraction?.maxLoadPerCpu === null || typeof extraction?.maxLoadPerCpu === "number").toBe(true);
		expect(extraction?.overloadBackoffMs === null || typeof extraction?.overloadBackoffMs === "number").toBe(true);
		expect(extraction).toHaveProperty("loadPerCpu");
		expect(extraction).toHaveProperty("overloadSince");
		expect(extraction).toHaveProperty("nextTickInMs");
	});

	it("exposes process memory metrics on /api/status", async () => {
		const res = await app.request("http://localhost/api/status");
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			resources?: {
				rss?: unknown;
				heapUsed?: unknown;
				physicalFootprint?: unknown;
				peakPhysicalFootprint?: unknown;
			};
		};
		expect(typeof body.resources?.rss).toBe("number");
		expect(typeof body.resources?.heapUsed).toBe("number");
		expect(body.resources?.physicalFootprint === null || typeof body.resources?.physicalFootprint === "number").toBe(
			true,
		);
		expect(
			body.resources?.peakPhysicalFootprint === null || typeof body.resources?.peakPhysicalFootprint === "number",
		).toBe(true);
	});

	it("exposes providerResolution.extraction runtime fields on /api/status", async () => {
		const res = await app.request("http://localhost/api/status");
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			providerResolution?: {
				extraction?: {
					configured?: unknown;
					resolved?: unknown;
					effective?: unknown;
					fallbackProvider?: unknown;
					status?: unknown;
					degraded?: unknown;
					fallbackApplied?: unknown;
					reason?: unknown;
					since?: unknown;
				};
			};
		};
		const extraction = body.providerResolution?.extraction;
		expect(extraction).toBeDefined();
		expect(typeof extraction?.resolved).toBe("string");
		expect(typeof extraction?.effective).toBe("string");
		// fallbackProvider must always be present as a string. #949 dropped this field
		// from the status object (it was sourcing from the retired flat config field),
		// which made `signet status` print "fallback: unknown". The type was widened
		// from the narrow "llama-cpp"|"ollama"|"none" enum to RuntimeProviderName
		// because the routing registry's fallbackTargetRefs can resolve to any
		// executor. Asserting presence + string type is the real regression guard.
		expect(typeof extraction?.fallbackProvider).toBe("string");
		expect(
			extraction?.status === "active" ||
				extraction?.status === "degraded" ||
				extraction?.status === "blocked" ||
				extraction?.status === "disabled" ||
				extraction?.status === "paused",
		).toBe(true);
		expect(typeof extraction?.degraded).toBe("boolean");
		expect(typeof extraction?.fallbackApplied).toBe("boolean");
		expect(extraction).toHaveProperty("reason");
		expect(extraction).toHaveProperty("since");
	});

	it("reports the selected fallback executor in providerResolution.extraction.effective", async () => {
		const originalOpenAiKey = process.env.OPENAI_API_KEY;
		const originalFetch = globalThis.fetch;
		Reflect.deleteProperty(process.env, "OPENAI_API_KEY");
		globalThis.fetch = (async (input: RequestInfo | URL) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
			if (url === "http://127.0.0.1:8080/v1/models") {
				return new Response(JSON.stringify({ data: [{ id: "qwen3:4b" }] }), { status: 200 });
			}
			return new Response("not found", { status: 404 });
		}) as typeof fetch;

		try {
			const { closeDbAccessor, initDbAccessor } = await import("./db-accessor");
			const { loadMemoryConfig } = await import("./memory-config");
			const state = await import("./routes/state.js");
			closeDbAccessor();
			initDbAccessor(join(dir, "memory", "memories.db"), { agentsDir: dir });
			writeFileSync(
				join(dir, "agent.yaml"),
				`memory:
  pipelineV2:
    enabled: true
    extraction:
      provider: openai-compatible
      model: remote-model
      endpoint: https://gateway.example.test/v1
      fallbackProvider: llama-cpp
    synthesis:
      enabled: false
    worker:
      threadedExtraction: false
`,
			);
			expect(state.restartPipelineRuntimeRef).toBeDefined();
			await state.restartPipelineRuntimeRef?.(loadMemoryConfig(dir));

			const res = await app.request("http://localhost/api/status");
			expect(res.status).toBe(200);
			const body = (await res.json()) as {
				providerResolution?: {
					extraction?: {
						effective?: unknown;
						fallbackProvider?: unknown;
						status?: unknown;
					};
				};
			};
			expect(body.providerResolution?.extraction?.effective).toBe("llama-cpp");
			// #960: the routing cutover dropped fallbackProvider from the status object.
			// With a legacy fallbackProvider: llama-cpp config (migrated to a routing
			// fallback target), the field must report the fallback executor — not be
			// undefined, which made `signet status` print "fallback: unknown".
			expect(body.providerResolution?.extraction?.fallbackProvider).toBe("llama-cpp");
			expect(["active", "degraded"]).toContain(body.providerResolution?.extraction?.status);
		} finally {
			globalThis.fetch = originalFetch;
			if (originalOpenAiKey === undefined) {
				Reflect.deleteProperty(process.env, "OPENAI_API_KEY");
			} else {
				process.env.OPENAI_API_KEY = originalOpenAiKey;
			}
		}
	});

	it("keeps legacy extraction disabled when Dreaming owns the semantic cutover", async () => {
		const { closeDbAccessor, initDbAccessor } = await import("./db-accessor");
		const { loadMemoryConfig } = await import("./memory-config");
		const { getLlmConcurrencyStatus } = await import("./pipeline/provider");
		const state = await import("./routes/state.js");
		closeDbAccessor();
		initDbAccessor(join(dir, "memory", "memories.db"), { agentsDir: dir });
		writeFileSync(
			join(dir, "agent.yaml"),
			`memory:
  pipelineV2:
    enabled: true
    extraction:
      provider: command
      command:
        bin: node
    worker:
      maxLlmConcurrency: 1
  dreaming:
    enabled: true
`,
		);

		expect(state.restartPipelineRuntimeRef).toBeDefined();
		await state.restartPipelineRuntimeRef?.(loadMemoryConfig(dir));
		const res = await app.request("http://localhost/api/status");
		const body = (await res.json()) as {
			providerResolution?: {
				extraction?: {
					configured?: unknown;
					resolved?: unknown;
					effective?: unknown;
					status?: unknown;
					enabled?: unknown;
					paused?: unknown;
					workerRunning?: unknown;
					ready?: unknown;
					blockedReason?: unknown;
				};
			};
		};
		expect(res.status).toBe(200);
		expect(body.providerResolution?.extraction).toMatchObject({
			status: "disabled",
			effective: "none",
			enabled: false,
			paused: false,
			workerRunning: false,
			ready: false,
			blockedReason: null,
		});

		expect(getLlmConcurrencyStatus().limit).toBe(1);
	});

	it("counts non-errored connectors as active for heartbeat telemetry", () => {
		expect(countConnectorsActive([{ status: "idle" }, { status: "syncing" }, { status: "error" }])).toBe(2);
	});
});

describe("legacy extraction cutover sweep (#946)", () => {
	const DREAMING_DISABLED_CONFIG = `memory:
  pipelineV2:
    enabled: true
    extraction:
      provider: command
      command:
        bin: node
`;
	const DREAMING_ENABLED_CONFIG = `memory:
  pipelineV2:
    enabled: true
    extraction:
      provider: command
      command:
        bin: node
  dreaming:
    enabled: true
`;

	function writeConfig(cfg: string): void {
		writeFileSync(join(dir, "agent.yaml"), cfg);
	}

	async function restartRuntime(cfg: string): Promise<void> {
		const { loadMemoryConfig } = await import("./memory-config");
		const state = await import("./routes/state.js");
		writeConfig(cfg);
		expect(state.restartPipelineRuntimeRef).toBeDefined();
		await state.restartPipelineRuntimeRef?.(loadMemoryConfig(dir));
	}

	function seedMemory(memoryId: string): void {
		const { getDbAccessor } = require("./db-accessor") as typeof import("./db-accessor");
		const now = new Date().toISOString();
		getDbAccessor().withWriteTx((db) => {
			db.prepare(
				"INSERT INTO memories (id, content, extraction_status, agent_id, created_at, updated_at) VALUES (?, ?, 'queued', 'default', ?, ?)",
			).run(memoryId, `seed ${memoryId}`, now, now);
		});
	}

	function seedPendingLegacyJob(memoryId: string, jobId: string): void {
		const { getDbAccessor } = require("./db-accessor") as typeof import("./db-accessor");
		const now = new Date().toISOString();
		seedMemory(memoryId);
		getDbAccessor().withWriteTx((db) => {
			db.prepare(
				`INSERT INTO memory_jobs
				 (id, memory_id, job_type, status, attempts, max_attempts, created_at, updated_at)
				 VALUES (?, ?, 'extract', 'pending', 0, 3, ?, ?)`,
			).run(jobId, memoryId, now, now);
		});
	}

	function seedLeasedLegacyJob(memoryId: string, jobId: string): void {
		const { getDbAccessor } = require("./db-accessor") as typeof import("./db-accessor");
		const now = new Date().toISOString();
		seedMemory(memoryId);
		getDbAccessor().withWriteTx((db) => {
			db.prepare(
				`INSERT INTO memory_jobs
				 (id, memory_id, job_type, status, attempts, max_attempts, leased_at, created_at, updated_at)
				 VALUES (?, ?, 'extract', 'leased', 0, 3, ?, ?, ?)`,
			).run(jobId, memoryId, now, now, now);
		});
	}

	function getJob(jobId: string): { status: string; error: string | null } {
		const { getDbAccessor } = require("./db-accessor") as typeof import("./db-accessor");
		return getDbAccessor().withReadDb(
			(db) =>
				db.prepare("SELECT status, error FROM memory_jobs WHERE id = ?").get(jobId) as {
					status: string;
					error: string | null;
				},
		);
	}

	function getMemoryStatus(memoryId: string): string {
		const { getDbAccessor } = require("./db-accessor") as typeof import("./db-accessor");
		return getDbAccessor().withReadDb(
			(db) =>
				db.prepare("SELECT extraction_status FROM memories WHERE id = ?").get(memoryId) as {
					extraction_status: string;
				},
		).extraction_status;
	}

	function countMemoryJobs(): number {
		const { getDbAccessor } = require("./db-accessor") as typeof import("./db-accessor");
		return getDbAccessor().withReadDb(
			(db) => db.prepare("SELECT COUNT(*) as cnt FROM memory_jobs").get() as { cnt: number },
		).cnt;
	}

	beforeEach(async () => {
		// Re-init a clean DB so each assertion sees only its own seed rows.
		const { closeDbAccessor, initDbAccessor } = await import("./db-accessor");
		closeDbAccessor();
		initDbAccessor(join(dir, "memory", "memories.db"), { agentsDir: dir });
	});

	it("retires pre-existing pending legacy extract jobs when Dreaming is enabled", async () => {
		await restartRuntime(DREAMING_DISABLED_CONFIG);
		seedPendingLegacyJob("mem-cutover", "job-cutover");

		// Startup/restart transition: enabling Dreaming sweeps the pending backlog.
		await restartRuntime(DREAMING_ENABLED_CONFIG);

		const job = getJob("job-cutover");
		expect(job.status).toBe("dead");
		expect(job.error).toBe("Dreaming cutover: legacy extraction worker not started");
		expect(getMemoryStatus("mem-cutover")).toBe("failed");
	});

	it("does not retire pending legacy extract jobs when Dreaming is disabled", async () => {
		seedPendingLegacyJob("mem-noop", "job-noop");

		await restartRuntime(DREAMING_DISABLED_CONFIG);

		const job = getJob("job-noop");
		expect(job.status).toBe("pending");
		expect(job.error).toBeNull();
		expect(getMemoryStatus("mem-noop")).toBe("queued");
	});

	it("preserves leased (in-flight) legacy extract jobs during the sweep", async () => {
		await restartRuntime(DREAMING_DISABLED_CONFIG);
		seedPendingLegacyJob("mem-pend", "job-pend");
		seedLeasedLegacyJob("mem-leased", "job-leased");

		await restartRuntime(DREAMING_ENABLED_CONFIG);

		const pendingJob = getJob("job-pend");
		expect(pendingJob.status).toBe("dead");
		const leasedJob = getJob("job-leased");
		expect(leasedJob.status).toBe("leased");
		// Leased memory is not marked failed (in-flight work may still complete).
		expect(getMemoryStatus("mem-leased")).toBe("queued");
	});

	it("is idempotent across repeated Dreaming restarts", async () => {
		seedPendingLegacyJob("mem-idem", "job-idem");
		await restartRuntime(DREAMING_ENABLED_CONFIG);
		const afterFirst = countMemoryJobs();
		expect(getJob("job-idem").status).toBe("dead");

		// A second restart must not duplicate, delete, or re-mutate rows.
		await restartRuntime(DREAMING_ENABLED_CONFIG);
		expect(countMemoryJobs()).toBe(afterFirst);
		const job = getJob("job-idem");
		expect(job.status).toBe("dead");
		expect(job.error).toBe("Dreaming cutover: legacy extraction worker not started");
	});
});

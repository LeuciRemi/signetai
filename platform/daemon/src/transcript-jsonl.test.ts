import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ensureCanonicalTranscriptHistory } from "./session-transcripts";
import { appendCanonicalTranscriptTurns, canonicalTranscriptPath } from "./transcript-jsonl";

const roots: string[] = [];

function makeRoot(name: string): string {
	const root = join(tmpdir(), `signet-transcript-jsonl-${name}-${process.pid}-${Date.now()}`);
	roots.push(root);
	return root;
}

afterEach(() => {
	for (const root of roots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

describe("canonical transcript JSONL", () => {
	test("waits for the transcript file lock before writing live turns", async () => {
		const root = makeRoot("lock");
		const path = canonicalTranscriptPath(root, "codex");
		const lock = `${path}.lock`;
		mkdirSync(lock, { recursive: true });

		const moduleUrl = pathToFileURL(fileURLToPath(new URL("./transcript-jsonl.ts", import.meta.url))).href;
		const worker = join(root, "append-worker.mjs");
		writeFileSync(
			worker,
			`
import { appendCanonicalTranscriptTurns } from ${JSON.stringify(moduleUrl)};

await appendCanonicalTranscriptTurns({
  basePath: process.env.TEST_SIGNET_ROOT,
  agentId: "default",
  harness: "codex",
  sessionKey: "locked-session",
  sourceFormat: "live",
  turns: [{ role: "user", content: "queued while lock is held" }],
});
`,
			"utf8",
		);

		const proc = Bun.spawn([process.execPath, worker], {
			env: { ...process.env, TEST_SIGNET_ROOT: root },
			stdout: "pipe",
			stderr: "pipe",
		});

		await Bun.sleep(100);
		expect(existsSync(path)).toBe(false);

		rmSync(lock, { recursive: true, force: true });
		expect(await proc.exited).toBe(0);
		expect(readFileSync(path, "utf8")).toContain("queued while lock is held");
	});

	test("retries legacy markdown backfill after a transient read failure", async () => {
		const root = makeRoot("retry");
		const memoryDir = join(root, "memory");
		const artifact = join(memoryDir, "2026-04-26T00-00-00Z--aaaaaaaaaaaaaaaa--transcript.md");
		mkdirSync(dirname(artifact), { recursive: true });
		writeFileSync(
			artifact,
			[
				"---",
				'kind: "transcript"',
				'agent_id: "default"',
				'harness: "codex"',
				'session_key: "retry-session"',
				'session_id: "retry-session"',
				'captured_at: "2026-04-26T00:00:00.000Z"',
				'project: "/tmp/project"',
				"---",
				"User: legacy hello",
				"Assistant: migrated now",
				"",
			].join("\n"),
			"utf8",
		);

		chmodSync(artifact, 0);
		await ensureCanonicalTranscriptHistory(root, "default");
		expect(existsSync(join(root, "memory", "codex", "transcripts", "transcript.jsonl"))).toBe(false);

		chmodSync(artifact, 0o600);
		await ensureCanonicalTranscriptHistory(root, "default");

		const transcript = readFileSync(join(root, "memory", "codex", "transcripts", "transcript.jsonl"), "utf8");
		expect(transcript).toContain("legacy hello");
		expect(transcript).toContain("migrated now");
	});

	test("preserves concurrent live appends to the same harness file", async () => {
		const root = makeRoot("concurrent");
		await Promise.all(
			Array.from({ length: 12 }, (_, index) =>
				Promise.resolve().then(() =>
					appendCanonicalTranscriptTurns({
						basePath: root,
						agentId: "default",
						harness: "codex",
						sessionKey: "concurrent-session",
						sourceFormat: "live",
						turns: [{ role: "user", content: `concurrent turn ${index}` }],
					}),
				),
			),
		);

		const transcript = readFileSync(join(root, "memory", "codex", "transcripts", "transcript.jsonl"), "utf8");
		for (let index = 0; index < 12; index++) {
			expect(transcript).toContain(`concurrent turn ${index}`);
		}
	});

	test("deduplicates retried live appends for the same trailing turns", async () => {
		const root = makeRoot("dedupe");
		const input = {
			basePath: root,
			agentId: "default",
			harness: "codex",
			sessionKey: "retry-live-session",
			sourceFormat: "live" as const,
			turns: [
				{ role: "assistant" as const, content: "same assistant context" },
				{ role: "user" as const, content: "same retried prompt" },
			],
		};

		await appendCanonicalTranscriptTurns(input);
		await appendCanonicalTranscriptTurns(input);

		const transcript = readFileSync(join(root, "memory", "codex", "transcripts", "transcript.jsonl"), "utf8");
		expect(transcript.match(/same assistant context/g)?.length).toBe(1);
		expect(transcript.match(/same retried prompt/g)?.length).toBe(1);
	});
});

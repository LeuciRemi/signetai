import { afterEach, describe, expect, test } from "bun:test";
import { Command } from "commander";
import { registerDreamCommands } from "./dream";

const previousLog = console.log;

afterEach(() => {
	console.log = previousLog;
});

describe("Dreaming capability CLI binding", () => {
	test("discovers the daemon-owned registry without a local capability list", async () => {
		const calls: string[] = [];
		const program = new Command();
		registerDreamCommands(program, {
			fetchFromDaemon: async (path) => {
				calls.push(path);
				return { items: [{ id: "search_entities", description: "Search entities" }] };
			},
		});
		console.log = () => {};
		await program.parseAsync(["node", "test", "dream", "capabilities"]);
		expect(calls).toEqual(["/api/dream/tools"]);
	});

	test("routes any registered capability through the daemon capability endpoint with an explicit agent scope", async () => {
		const calls: Array<{ path: string; options?: RequestInit }> = [];
		const program = new Command();
		registerDreamCommands(program, {
			fetchFromDaemon: async (path, options) => {
				calls.push({ path, options });
				return { ok: true, tool: "search_entities", items: [] };
			},
		});
		console.log = () => {};
		await program.parseAsync([
			"node",
			"test",
			"dream",
			"tool",
			"search_entities",
			"--agent",
			"agent-a",
			"--pass-id",
			"pass-a",
			"--input",
			'{"query":"Atlas"}',
		]);
		expect(calls).toEqual([
			{
				path: "/api/dream/tools/search_entities",
				options: expect.objectContaining({
					method: "POST",
					body: JSON.stringify({ input: { query: "Atlas" }, agentId: "agent-a", passId: "pass-a" }),
				}),
			},
		]);
	});
});

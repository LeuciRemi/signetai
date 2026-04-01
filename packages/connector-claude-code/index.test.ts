import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeCodeConnector } from "./src/index.js";

const origHome = process.env.HOME;
let tmpRoot = "";

beforeEach(() => {
	tmpRoot = mkdtempSync(join(tmpdir(), "signet-claude-code-test-"));
	process.env.HOME = tmpRoot;
});

afterEach(() => {
	if (origHome !== undefined) process.env.HOME = origHome;
	else delete process.env.HOME;
	if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
});

describe("ClaudeCodeConnector.install — legacy SIGNET block migration", () => {
	it("strips legacy block from AGENTS.md and reports path in filesWritten", async () => {
		const agentsPath = join(tmpRoot, "AGENTS.md");
		writeFileSync(
			agentsPath,
			`before\n<!-- SIGNET:START -->\nmanaged block\n<!-- SIGNET:END -->\nafter\n`,
			"utf-8",
		);
		const result = await new ClaudeCodeConnector().install(tmpRoot);
		expect(readFileSync(agentsPath, "utf-8")).toBe("before\nafter\n");
		expect(result.filesWritten).toContain(agentsPath);
	});

	it("leaves AGENTS.md untouched when no legacy block present", async () => {
		const agentsPath = join(tmpRoot, "AGENTS.md");
		writeFileSync(agentsPath, "plain content\n", "utf-8");
		const result = await new ClaudeCodeConnector().install(tmpRoot);
		expect(readFileSync(agentsPath, "utf-8")).toBe("plain content\n");
		expect(result.filesWritten).not.toContain(agentsPath);
	});
});

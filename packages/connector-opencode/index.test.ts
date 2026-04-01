import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpenCodeConnector } from "./src/index.js";

const origHome = process.env.HOME;
let tmpRoot = "";

function writeIdentity(dir: string): void {
	for (const file of ["AGENTS.md", "SOUL.md", "IDENTITY.md", "USER.md"]) {
		writeFileSync(join(dir, file), `# ${file}\n`, "utf-8");
	}
}

beforeEach(() => {
	tmpRoot = mkdtempSync(join(tmpdir(), "signet-opencode-test-"));
	process.env.HOME = tmpRoot;
	mkdirSync(join(tmpRoot, ".config", "opencode"), { recursive: true });
});

afterEach(() => {
	if (origHome !== undefined) process.env.HOME = origHome;
	else delete process.env.HOME;
	if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
});

describe("OpenCodeConnector.install — legacy SIGNET block migration", () => {
	it("strips legacy block from AGENTS.md and reports path in filesWritten", async () => {
		writeIdentity(tmpRoot);
		const agentsPath = join(tmpRoot, "AGENTS.md");
		writeFileSync(
			agentsPath,
			`before\n<!-- SIGNET:START -->\nmanaged block\n<!-- SIGNET:END -->\nafter\n`,
			"utf-8",
		);
		const result = await new OpenCodeConnector().install(tmpRoot);
		expect(readFileSync(agentsPath, "utf-8")).toBe("before\nafter\n");
		expect(result.filesWritten).toContain(agentsPath);
	});

	it("leaves AGENTS.md untouched when no legacy block present", async () => {
		writeIdentity(tmpRoot);
		const agentsPath = join(tmpRoot, "AGENTS.md");
		const result = await new OpenCodeConnector().install(tmpRoot);
		expect(readFileSync(agentsPath, "utf-8")).toBe("# AGENTS.md\n");
		expect(result.filesWritten).not.toContain(agentsPath);
	});

	it("does not strip AGENTS.md when identity check fails", async () => {
		const agentsPath = join(tmpRoot, "AGENTS.md");
		writeFileSync(
			agentsPath,
			`before\n<!-- SIGNET:START -->\nmanaged block\n<!-- SIGNET:END -->\nafter\n`,
			"utf-8",
		);
		const result = await new OpenCodeConnector().install(tmpRoot);
		expect(result.success).toBe(false);
		expect(readFileSync(agentsPath, "utf-8")).toContain("<!-- SIGNET:START -->");
		expect(result.filesWritten).toHaveLength(0);
	});
});

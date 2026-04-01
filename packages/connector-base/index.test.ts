import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type InstallResult, type UninstallResult, BaseConnector } from "./src/index";

class TestConnector extends BaseConnector {
	readonly name = "Test";
	readonly harnessId = "test";

	public cleanup(path: string): string | null {
		return this.stripLegacySignetBlock(path);
	}

	async install(_basePath: string): Promise<InstallResult> {
		return { success: true, message: "ok", filesWritten: [] };
	}

	async uninstall(): Promise<UninstallResult> {
		return { filesRemoved: [] };
	}

	isInstalled(): boolean {
		return false;
	}

	getConfigPath(): string {
		return "";
	}
}

let dir = "";

afterEach(() => {
	if (dir) rmSync(dir, { recursive: true, force: true });
	dir = "";
});

describe("BaseConnector.stripLegacySignetBlock", () => {
	it("removes SIGNET marker block from AGENTS.md in place", () => {
		dir = mkdtempSync(join(tmpdir(), "signet-connector-base-test-"));
		const file = join(dir, "AGENTS.md");
		writeFileSync(
			file,
			`before\n<!-- SIGNET:START -->\nmanaged block\n<!-- SIGNET:END -->\nafter\n`,
			"utf-8",
		);

		const connector = new TestConnector();
		const strippedPath = connector.cleanup(dir);
		expect(strippedPath).toBe(file);
		expect(readFileSync(file, "utf-8")).toBe("before\nafter\n");
	});

	it("does nothing when AGENTS.md has no SIGNET block", () => {
		dir = mkdtempSync(join(tmpdir(), "signet-connector-base-test-"));
		const file = join(dir, "AGENTS.md");
		writeFileSync(file, "plain content\n", "utf-8");

		const connector = new TestConnector();
		const strippedPath = connector.cleanup(dir);
		expect(strippedPath).toBeNull();
		expect(readFileSync(file, "utf-8")).toBe("plain content\n");
	});

	it("does nothing when AGENTS.md is missing", () => {
		dir = mkdtempSync(join(tmpdir(), "signet-connector-base-test-"));

		const connector = new TestConnector();
		const strippedPath = connector.cleanup(dir);
		expect(strippedPath).toBeNull();
		expect(existsSync(join(dir, "AGENTS.md"))).toBe(false);
	});
});

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ForgeConnector } from "./src/index.js";

const originalHome = process.env.HOME;
let tmpRoot = "";

type JsonObject = Record<string, unknown>;

function isJsonObject(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readJsonObject(path: string): JsonObject {
	const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
	if (!isJsonObject(parsed)) {
		throw new Error("Expected a JSON object");
	}
	return parsed;
}

beforeEach(() => {
	tmpRoot = mkdtempSync(join(tmpdir(), "signet-forge-connector-"));
	process.env.HOME = tmpRoot;
});

afterEach(() => {
	if (typeof originalHome === "string") {
		process.env.HOME = originalHome;
	} else {
		// biome-ignore lint/performance/noDelete: env vars coerce undefined to "undefined"
		delete process.env.HOME;
	}
	if (tmpRoot) {
		rmSync(tmpRoot, { recursive: true, force: true });
	}
});

function writeIdentity(basePath: string): void {
	mkdirSync(basePath, { recursive: true });
	writeFileSync(join(basePath, "AGENTS.md"), "# Agent\n\nForge me.\n", "utf-8");
	writeFileSync(join(basePath, "SOUL.md"), "Steady\n", "utf-8");
	writeFileSync(join(basePath, "IDENTITY.md"), "Connector test\n", "utf-8");
	writeFileSync(join(basePath, "USER.md"), "Nicholai\n", "utf-8");
	writeFileSync(join(basePath, "MEMORY.md"), "Remember this\n", "utf-8");
	const skillsDir = join(basePath, "skills", "test-skill");
	mkdirSync(skillsDir, { recursive: true });
	writeFileSync(join(skillsDir, "SKILL.md"), "---\nname: test-skill\n---\n", "utf-8");
}

describe("ForgeConnector", () => {
	it("installs ForgeCode AGENTS, skills, and MCP config", async () => {
		const basePath = join(tmpRoot, "agents");
		writeIdentity(basePath);

		const connector = new ForgeConnector();
		const result = await connector.install(basePath);
		const forgeHome = join(tmpRoot, "forge");
		const agentsPath = join(forgeHome, "AGENTS.md");
		const mcpPath = join(forgeHome, ".mcp.json");
		const skillPath = join(forgeHome, "skills", "test-skill");

		expect(result.success).toBe(true);
		expect(result.filesWritten).toContain(agentsPath);
		expect(result.configsPatched).toContain(mcpPath);
		expect(existsSync(agentsPath)).toBe(true);
		expect(existsSync(mcpPath)).toBe(true);
		expect(existsSync(skillPath)).toBe(true);
		expect(lstatSync(skillPath).isSymbolicLink()).toBe(true);

		const agents = readFileSync(agentsPath, "utf-8");
		expect(agents).toContain("Managed by Signet (@signet/connector-forge)");
		expect(agents).toContain("# Agent");
		expect(agents).toContain("## SOUL");
		expect(agents).toContain("## IDENTITY");
		expect(agents).toContain("## USER");
		expect(agents).toContain("## MEMORY");

		const config = readJsonObject(mcpPath);
		const servers = config.mcpServers;
		expect(isJsonObject(servers)).toBe(true);
		if (!isJsonObject(servers)) {
			throw new Error("Expected mcpServers in Forge config");
		}
		const signet = servers.signet;
		expect(isJsonObject(signet)).toBe(true);
		if (!isJsonObject(signet)) {
			throw new Error("Expected signet MCP server in Forge config");
		}
		expect(signet.command).toBe(process.platform === "win32" ? process.execPath : "signet-mcp");
		if (process.platform !== "win32") {
			expect(Reflect.has(signet, "args")).toBe(false);
		}
		const env = signet.env;
		expect(isJsonObject(env)).toBe(true);
		if (!isJsonObject(env)) {
			throw new Error("Expected env block in signet MCP server");
		}
		expect(env.SIGNET_PATH).toBe(basePath);
		expect(connector.isInstalled()).toBe(true);
	});

	it("preserves unrelated MCP servers and removes only the Signet entry on uninstall", async () => {
		const basePath = join(tmpRoot, "agents");
		writeIdentity(basePath);

		const forgeHome = join(tmpRoot, "forge");
		mkdirSync(forgeHome, { recursive: true });
		writeFileSync(
			join(forgeHome, ".mcp.json"),
			`${JSON.stringify(
				{
					mcpServers: {
						existing: {
							command: "existing-mcp",
						},
					},
				},
				null,
				2,
			)}\n`,
			"utf-8",
		);

		const connector = new ForgeConnector();
		await connector.install(basePath);
		const skillPath = join(forgeHome, "skills", "test-skill");
		expect(existsSync(skillPath)).toBe(true);
		expect(lstatSync(skillPath).isSymbolicLink()).toBe(true);

		const uninstall = await connector.uninstall();
		const config = readJsonObject(join(forgeHome, ".mcp.json"));
		const servers = config.mcpServers;

		expect(uninstall.configsPatched).toContain(join(forgeHome, ".mcp.json"));
		expect(uninstall.filesRemoved).toContain(join(forgeHome, "AGENTS.md"));
		expect(uninstall.filesRemoved).toContain(skillPath);
		expect(existsSync(skillPath)).toBe(false);
		expect(isJsonObject(servers)).toBe(true);
		if (!isJsonObject(servers)) {
			throw new Error("Expected mcpServers in Forge config");
		}
		const existing = servers.existing;
		expect(isJsonObject(existing)).toBe(true);
		if (!isJsonObject(existing)) {
			throw new Error("Expected existing MCP server to be preserved");
		}
		expect(existing.command).toBe("existing-mcp");
		expect(Reflect.has(servers, "signet")).toBe(false);
		expect(connector.isInstalled()).toBe(false);
	});

	it("does not remove user-owned symlinks pointing outside the Signet workspace", async () => {
		const basePath = join(tmpRoot, "agents");
		writeIdentity(basePath);

		const connector = new ForgeConnector();
		await connector.install(basePath);

		// Simulate a user-created symlink in ~/forge/skills/ pointing to
		// an unrelated directory, not the Signet workspace.
		const forgeHome = join(tmpRoot, "forge");
		const userSkillTarget = join(tmpRoot, "my-own-skill");
		mkdirSync(userSkillTarget, { recursive: true });
		const userSkillLink = join(forgeHome, "skills", "user-skill");
		symlinkSync(userSkillTarget, userSkillLink);

		const uninstall = await connector.uninstall();

		// Signet-managed skill is gone; user-owned symlink is preserved.
		expect(uninstall.filesRemoved).not.toContain(userSkillLink);
		expect(existsSync(userSkillLink)).toBe(true);
		expect(lstatSync(userSkillLink).isSymbolicLink()).toBe(true);
	});

	it("fails safely when Forge MCP config is invalid JSON", async () => {
		const basePath = join(tmpRoot, "agents");
		writeIdentity(basePath);

		const forgeHome = join(tmpRoot, "forge");
		mkdirSync(forgeHome, { recursive: true });
		writeFileSync(join(forgeHome, ".mcp.json"), "{broken", "utf-8");

		const result = await new ForgeConnector().install(basePath);
		expect(result.success).toBe(false);
		expect(result.message).toContain("Failed to read Forge MCP config");
		expect(existsSync(join(forgeHome, "AGENTS.md"))).toBe(false);
	});

	it("fails safely when Signet identity is missing", async () => {
		// basePath exists but has no identity files — hasValidIdentity returns false.
		const basePath = join(tmpRoot, "empty-agents");
		mkdirSync(basePath, { recursive: true });

		const result = await new ForgeConnector().install(basePath);
		expect(result.success).toBe(false);
		expect(result.message).toContain("No valid Signet identity found at");
		expect(result.message).toContain(basePath);
		// Nothing should be written to ~/forge.
		expect(existsSync(join(tmpRoot, "forge", "AGENTS.md"))).toBe(false);
	});
});

describe("Forge connector wiring", () => {
	it("adds the Forge connector to the shared dependency build batch", () => {
		const dir = dirname(fileURLToPath(import.meta.url));
		const path = resolve(dir, "..", "..", "package.json");
		const text = readFileSync(path, "utf-8");
		const deps = text.match(/"build:deps":\s*"([^"]+)"/)?.[1] ?? "";

		expect(deps).toContain("@signet/connector-forge");
	});

	it("wires the CLI to depend on the Forge connector package", () => {
		const dir = dirname(fileURLToPath(import.meta.url));
		const path = resolve(dir, "..", "cli", "package.json");
		const text = readFileSync(path, "utf-8");

		expect(text).toContain('"@signet/connector-forge": "workspace:*"');
	});
});

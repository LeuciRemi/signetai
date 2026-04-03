import {
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	readlinkSync,
	rmSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { BaseConnector, type InstallResult, type UninstallResult, atomicWriteJson } from "@signet/connector-base";
import { expandHome, hasValidIdentity } from "@signet/core";

const SIGNET_FORGE_MARKER = "Managed by Signet (@signet/connector-forge)";

type JsonObject = Record<string, unknown>;

function getHomeDir(): string {
	const home = process.env.HOME?.trim();
	return home && home.length > 0 ? home : homedir();
}

function isJsonObject(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readJsonObject(path: string): JsonObject {
	if (!existsSync(path)) {
		return {};
	}

	const raw = readFileSync(path, "utf-8");
	const parsed: unknown = JSON.parse(raw);
	if (!isJsonObject(parsed)) {
		throw new Error("Forge MCP config must be a top-level object");
	}

	return parsed;
}

function readMcpServers(config: JsonObject): JsonObject {
	if (!("mcpServers" in config)) {
		return {};
	}

	const current = config.mcpServers;
	if (isJsonObject(current)) {
		return { ...current };
	}

	throw new Error("Forge MCP config field 'mcpServers' must be an object");
}

function resolveSignetMcp(): { command: string; args: string[] } {
	if (process.platform !== "win32") {
		return { command: "signet-mcp", args: [] };
	}

	// On Windows, spawn() without shell:true cannot resolve .cmd wrappers —
	// use node + the mcp-stdio.js entry point directly instead.
	// argv[1] is e.g. .../signetai/bin/signet.js; mcp-stdio.js lives at
	// .../signetai/dist/mcp-stdio.js (matches Claude Code / OpenCode pattern).
	//
	// Known limitation: the resolved absolute path is baked into
	// ~/forge/.mcp.json at install time. If signet is updated or relocated
	// after the initial setup, this path goes stale and ForgeCode will
	// silently fail to spawn the MCP server. Re-running `signet setup` after
	// an upgrade resolves the path afresh and overwrites the stale entry.
	const cliEntry = process.argv[1] || "";
	const mcpJs = join(cliEntry, "..", "..", "dist", "mcp-stdio.js");
	if (existsSync(mcpJs)) {
		return { command: process.execPath, args: [mcpJs] };
	}

	console.warn(
		`[signet] Warning: could not resolve mcp-stdio.js from argv[1]="${cliEntry}". MCP server config will use "signet-mcp" which may fail on Windows without shell:true.`,
	);
	return { command: "signet-mcp", args: [] };
}

function buildMcpServer(basePath: string): JsonObject {
	const mcp = resolveSignetMcp();
	return {
		command: mcp.command,
		...(mcp.args.length > 0 ? { args: mcp.args } : {}),
		env: {
			SIGNET_PATH: basePath,
		},
	};
}

export class ForgeConnector extends BaseConnector {
	readonly name = "ForgeCode";
	readonly harnessId = "forge";

	private getForgeHome(): string {
		return join(getHomeDir(), "forge");
	}

	private getAgentsPath(): string {
		return join(this.getForgeHome(), "AGENTS.md");
	}

	private getSkillsPath(): string {
		return join(this.getForgeHome(), "skills");
	}

	private getMcpConfigPath(): string {
		return join(this.getForgeHome(), ".mcp.json");
	}

	getConfigPath(): string {
		return this.getMcpConfigPath();
	}

	async install(basePath: string): Promise<InstallResult> {
		const filesWritten: string[] = [];
		const configsPatched: string[] = [];
		const expandedBasePath = expandHome(basePath || join(getHomeDir(), ".agents"));

		if (!hasValidIdentity(expandedBasePath)) {
			return {
				success: false,
				message: `No valid Signet identity found at ${expandedBasePath}`,
				filesWritten,
				configsPatched,
			};
		}

		const mcpPath = this.getMcpConfigPath();
		let config: JsonObject;
		try {
			config = readJsonObject(mcpPath);
		} catch (err) {
			const message = err instanceof Error ? err.message : "unknown error";
			return {
				success: false,
				message: `Failed to read Forge MCP config: ${message}`,
				filesWritten,
				configsPatched,
			};
		}

		// Wrap the write phase so infrastructure errors (permission denied,
		// disk full, ENOENT race, etc.) are surfaced as result-type failures
		// rather than thrown exceptions, keeping the contract consistent.
		try {
			const strippedAgentsPath = this.stripLegacySignetBlock(expandedBasePath);
			if (strippedAgentsPath !== null) {
				filesWritten.push(strippedAgentsPath);
			}

			const forgeHome = this.getForgeHome();
			mkdirSync(forgeHome, { recursive: true });

			const agentsPath = this.generateAgentsMd(expandedBasePath);
			filesWritten.push(agentsPath);

			this.registerMcpServer(config, expandedBasePath);
			atomicWriteJson(mcpPath, config);
			configsPatched.push(mcpPath);

			const skillsSource = join(expandedBasePath, "skills");
			if (existsSync(skillsSource)) {
				this.symlinkSkills(skillsSource, this.getSkillsPath());
			}
		} catch (err) {
			const message = err instanceof Error ? err.message : "unknown error";
			return {
				success: false,
				message: `ForgeCode integration install failed: ${message}`,
				filesWritten,
				configsPatched,
			};
		}

		return {
			success: true,
			message: "ForgeCode integration installed successfully",
			filesWritten,
			configsPatched,
		};
	}

	async uninstall(): Promise<UninstallResult> {
		const filesRemoved: string[] = [];
		const configsPatched: string[] = [];

		const agentsPath = this.getAgentsPath();
		if (existsSync(agentsPath)) {
			const content = readFileSync(agentsPath, "utf-8");
			if (content.includes(SIGNET_FORGE_MARKER)) {
				rmSync(agentsPath, { force: true });
				filesRemoved.push(agentsPath);
			}
		}

		// Read MCP config first so we can derive SIGNET_PATH before patching it.
		const mcpPath = this.getMcpConfigPath();
		let config: JsonObject = {};
		if (existsSync(mcpPath)) {
			try {
				config = readJsonObject(mcpPath);
			} catch {
				// Leave unreadable user config untouched.
			}
		}

		const signetPath = this.extractSignetPath(config);
		this.removeSkillSymlinks(filesRemoved, signetPath);

		if (Object.keys(config).length > 0) {
			try {
				const patched = this.removeMcpServer(config);
				if (patched) {
					if (Object.keys(config).length === 0) {
						rmSync(mcpPath, { force: true });
						filesRemoved.push(mcpPath);
					} else {
						atomicWriteJson(mcpPath, config);
						configsPatched.push(mcpPath);
					}
				}
			} catch {
				// Leave unpatchable config untouched.
			}
		}

		return { filesRemoved, configsPatched };
	}

	isInstalled(): boolean {
		if (existsSync(this.getAgentsPath())) {
			try {
				const content = readFileSync(this.getAgentsPath(), "utf-8");
				if (content.includes(SIGNET_FORGE_MARKER)) {
					return true;
				}
			} catch {
				// Ignore unreadable AGENTS.md and fall through to MCP config check.
			}
		}

		try {
			const config = readJsonObject(this.getMcpConfigPath());
			const servers = readMcpServers(config);
			return "signet" in servers;
		} catch {
			return false;
		}
	}

	private extractSignetPath(config: JsonObject): string | null {
		const servers = config.mcpServers;
		if (!isJsonObject(servers)) return null;
		const signet = servers.signet;
		if (!isJsonObject(signet)) return null;
		const env = signet.env;
		if (!isJsonObject(env)) return null;
		const path = env.SIGNET_PATH;
		return typeof path === "string" && path.length > 0 ? path : null;
	}

	private removeSkillSymlinks(filesRemoved: string[], signetPath: string | null): void {
		const skillsDir = this.getSkillsPath();
		if (!existsSync(skillsDir)) return;

		// If SIGNET_PATH couldn't be read from the MCP config (e.g. the user
		// manually edited .mcp.json, or a partial uninstall already stripped
		// the entry), fall back to the default workspace so Signet-managed
		// symlinks are still cleaned up rather than silently left behind.
		const source = signetPath ?? join(getHomeDir(), ".agents");
		const signetSkillsSource = join(source, "skills");

		try {
			for (const entry of readdirSync(skillsDir)) {
				const target = join(skillsDir, entry);
				if (!lstatSync(target).isSymbolicLink()) continue;
				// Only remove symlinks that point into the Signet skills source,
				// so user-created symlinks elsewhere are never touched.
				// Use isAbsolute + resolve for cross-platform correctness (Windows
				// absolute paths start with a drive letter, not "/").
				const linkTarget = readlinkSync(target);
				const resolved = isAbsolute(linkTarget) ? linkTarget : resolve(skillsDir, linkTarget);
				const rel = relative(signetSkillsSource, resolved);
				// Skip when resolved is outside signetSkillsSource. Use the canonical
				// parent-escape prefix (rel === ".." or starts with "../") rather than
				// bare startsWith("..") which would incorrectly exclude skill names
				// that happen to begin with the characters "..".
				if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) continue;
				unlinkSync(target);
				filesRemoved.push(target);
			}
			// Remove the skills directory itself if now empty.
			if (readdirSync(skillsDir).length === 0) {
				rmSync(skillsDir, { force: true });
			}
		} catch {
			// Leave unreadable skills directory untouched.
		}
	}

	private generateAgentsMd(basePath: string): string {
		const sourcePath = join(basePath, "AGENTS.md");
		const targetPath = this.getAgentsPath();
		const content = readFileSync(sourcePath, "utf-8").trim();
		const extras = this.composeIdentityExtras(basePath);
		const body = extras ? `${content}${extras}` : content;
		writeFileSync(
			targetPath,
			`# ${SIGNET_FORGE_MARKER}\n${this.generateHeader(sourcePath, this.name)}${body}\n`,
			"utf-8",
		);
		return targetPath;
	}

	private registerMcpServer(config: JsonObject, basePath: string): void {
		const servers = readMcpServers(config);
		servers.signet = buildMcpServer(basePath);
		config.mcpServers = servers;
	}

	private removeMcpServer(config: JsonObject): boolean {
		const servers = readMcpServers(config);
		if (!("signet" in servers)) {
			return false;
		}

		Reflect.deleteProperty(servers, "signet");
		if (Object.keys(servers).length === 0) {
			Reflect.deleteProperty(config, "mcpServers");
			return true;
		}

		config.mcpServers = servers;
		return true;
	}
}

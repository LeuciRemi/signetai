import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export type DesktopWorkspaceSource = "env" | "config" | "default";

export interface DesktopWorkspaceResolution {
	readonly path: string;
	readonly source: DesktopWorkspaceSource;
	readonly configPath: string;
	readonly configuredPath: string | null;
}

export function normalizeWorkspacePath(pathValue: string, home = homedir()): string {
	return resolve(expandHome(pathValue.trim(), home));
}

export function resolveDesktopWorkspace(
	env: NodeJS.ProcessEnv = process.env,
	home = homedir(),
): DesktopWorkspaceResolution {
	const configPath = getWorkspaceConfigPath(env, home);
	const envPath = readEnvPath(env, home);
	const configPathValue = readWorkspaceFromConfig(configPath, home);

	if (envPath) {
		return {
			path: envPath,
			source: "env",
			configPath,
			configuredPath: configPathValue,
		};
	}

	if (configPathValue) {
		return {
			path: configPathValue,
			source: "config",
			configPath,
			configuredPath: configPathValue,
		};
	}

	return {
		path: join(home, ".agents"),
		source: "default",
		configPath,
		configuredPath: null,
	};
}

export function applyDesktopWorkspaceEnv(
	resolution: DesktopWorkspaceResolution,
	env: NodeJS.ProcessEnv = process.env,
): DesktopWorkspaceResolution {
	env.SIGNET_PATH = resolution.path;
	env.SIGNET_WORKSPACE = resolution.path;
	return resolution;
}

function readEnvPath(env: NodeJS.ProcessEnv, home: string): string | null {
	for (const key of ["SIGNET_PATH", "SIGNET_WORKSPACE"] as const) {
		const raw = env[key];
		if (typeof raw !== "string") continue;
		const trimmed = raw.trim();
		if (trimmed.length > 0) return normalizeWorkspacePath(trimmed, home);
	}
	return null;
}

function getWorkspaceConfigPath(env: NodeJS.ProcessEnv, home: string): string {
	const raw = env.XDG_CONFIG_HOME;
	if (typeof raw !== "string") return join(home, ".config", "signet", "workspace.json");
	const trimmed = raw.trim();
	const configHome = trimmed.length > 0 ? normalizeWorkspacePath(trimmed, home) : join(home, ".config");
	return join(configHome, "signet", "workspace.json");
}

function readWorkspaceFromConfig(path: string, home: string): string | null {
	if (!existsSync(path)) return null;
	try {
		const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
		const workspace = Reflect.get(raw, "workspace");
		if (typeof workspace !== "string") return null;
		const trimmed = workspace.trim();
		return trimmed.length > 0 ? normalizeWorkspacePath(trimmed, home) : null;
	} catch {
		return null;
	}
}

function expandHome(pathValue: string, home: string): string {
	if (pathValue === "~") return home;
	return pathValue.startsWith("~/") || pathValue.startsWith("~\\") ? join(home, pathValue.slice(2)) : pathValue;
}

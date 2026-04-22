import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { applyDesktopWorkspaceEnv, resolveDesktopWorkspace } from "./workspace.js";

describe("desktop workspace resolution", () => {
	test("uses SIGNET_PATH before workspace config", () => {
		const home = mkdtempSync(join(tmpdir(), "signet-desktop-workspace-"));
		try {
			const configHome = join(home, "config");
			const envWorkspace = join(home, "env-workspace");
			const configuredWorkspace = join(home, "configured-workspace");
			mkdirSync(join(configHome, "signet"), { recursive: true });
			writeFileSync(
				join(configHome, "signet", "workspace.json"),
				JSON.stringify({ version: 1, workspace: configuredWorkspace }),
			);

			const result = resolveDesktopWorkspace({ SIGNET_PATH: envWorkspace, XDG_CONFIG_HOME: configHome }, home);

			expect(result.path).toBe(resolve(envWorkspace));
			expect(result.source).toBe("env");
			expect(result.configuredPath).toBe(resolve(configuredWorkspace));
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	test("uses SIGNET_WORKSPACE when SIGNET_PATH is not set", () => {
		const home = mkdtempSync(join(tmpdir(), "signet-desktop-workspace-"));
		try {
			const workspace = join(home, "workspace-env-alias");
			const result = resolveDesktopWorkspace({ SIGNET_WORKSPACE: workspace }, home);

			expect(result.path).toBe(resolve(workspace));
			expect(result.source).toBe("env");
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	test("uses workspace config when SIGNET_PATH is not set", () => {
		const home = mkdtempSync(join(tmpdir(), "signet-desktop-workspace-"));
		try {
			const configHome = join(home, "config");
			const configuredWorkspace = join(home, "configured-workspace");
			mkdirSync(join(configHome, "signet"), { recursive: true });
			writeFileSync(
				join(configHome, "signet", "workspace.json"),
				JSON.stringify({ version: 1, workspace: configuredWorkspace }),
			);

			const result = resolveDesktopWorkspace({ XDG_CONFIG_HOME: configHome }, home);

			expect(result.path).toBe(resolve(configuredWorkspace));
			expect(result.source).toBe("config");
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	test("falls back to the home directory .agents workspace", () => {
		const home = mkdtempSync(join(tmpdir(), "signet-desktop-workspace-"));
		try {
			const result = resolveDesktopWorkspace({}, home);

			expect(result.path).toBe(join(home, ".agents"));
			expect(result.source).toBe("default");
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	test("applies resolved workspace to both runtime env names", () => {
		const env: NodeJS.ProcessEnv = {};
		const resolution = {
			path: "/tmp/signet-workspace",
			source: "env" as const,
			configPath: "/tmp/config/signet/workspace.json",
			configuredPath: null,
		};

		expect(applyDesktopWorkspaceEnv(resolution, env)).toBe(resolution);
		expect(env.SIGNET_PATH).toBe(resolution.path);
		expect(env.SIGNET_WORKSPACE).toBe(resolution.path);
	});
});

import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function getInstallScriptPath(importMetaUrl: string = import.meta.url): string {
	const thisDir = dirname(fileURLToPath(importMetaUrl));
	const bundled = resolve(thisDir, "../scripts/install-graphiq.sh");
	if (existsSync(bundled)) return bundled;
	return resolve(thisDir, "../../../../scripts/install-graphiq.sh");
}

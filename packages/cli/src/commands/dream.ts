import chalk from "chalk";
import type { Command } from "commander";

interface DreamDeps {
	readonly fetchFromDaemon: <T>(path: string, opts?: RequestInit & { timeout?: number }) => Promise<T | null>;
}

interface DreamState {
	readonly tokensSinceLastPass: number;
	readonly lastPassAt: string | null;
	readonly lastPassId: string | null;
	readonly lastPassMode: string | null;
}

interface DreamPass {
	readonly id: string;
	readonly mode: string;
	readonly status: string;
	readonly startedAt: string;
	readonly completedAt: string | null;
	readonly tokensConsumed: number | null;
	readonly mutationsApplied: number | null;
	readonly mutationsSkipped: number | null;
	readonly mutationsFailed: number | null;
	readonly summary: string | null;
	readonly error: string | null;
}

interface DreamStatus {
	readonly enabled: boolean;
	readonly worker: { readonly running: boolean; readonly active: boolean };
	readonly state: DreamState;
	readonly config: {
		readonly provider: string;
		readonly model: string;
		readonly tokenThreshold: number;
		readonly backfillOnFirstRun: boolean;
	};
	readonly passes: readonly DreamPass[];
}

interface TriggerAccepted {
	readonly accepted: boolean;
	readonly passId: string;
	readonly status: string;
	readonly mode: string;
	readonly error?: string;
}

export function registerDreamCommands(program: Command, deps: DreamDeps): void {
	const dream = program.command("dream").description("Manage dreaming memory consolidation");

	dream
		.command("status")
		.description("Show dreaming worker status and recent passes")
		.action(async () => {
			const data = await deps.fetchFromDaemon<DreamStatus>("/api/dream/status");
			if (!data) {
				console.error(chalk.red("Failed to get dreaming status (is the daemon running?)"));
				process.exit(1);
			}

			console.log(chalk.bold("\n  Dreaming Status\n"));

			const enabled = data.enabled ? chalk.green("enabled") : chalk.dim("disabled");
			const worker = data.worker.running
				? data.worker.active
					? chalk.yellow("running pass")
					: chalk.green("idle")
				: chalk.dim("stopped");

			console.log(`  ${chalk.dim("Enabled:")}    ${enabled}`);
			console.log(`  ${chalk.dim("Worker:")}     ${worker}`);
			console.log(`  ${chalk.dim("Provider:")}   ${data.config.provider} / ${data.config.model}`);
			console.log(
				`  ${chalk.dim("Threshold:")}  ${data.state.tokensSinceLastPass} / ${data.config.tokenThreshold} tokens`,
			);

			if (data.state.lastPassAt) {
				console.log(`  ${chalk.dim("Last pass:")}  ${data.state.lastPassAt} (${data.state.lastPassMode})`);
			} else {
				console.log(`  ${chalk.dim("Last pass:")}  ${chalk.dim("never")}`);
			}

			if (data.passes.length > 0) {
				console.log(chalk.bold("\n  Recent Passes\n"));
				console.log(
					`  ${chalk.dim("STATUS".padEnd(12))}${chalk.dim("MODE".padEnd(14))}${chalk.dim("MUTATIONS".padEnd(24))}${chalk.dim("STARTED")}`,
				);
				for (const pass of data.passes) {
					const status =
						pass.status === "completed"
							? chalk.green(pass.status)
							: pass.status === "failed"
								? chalk.red(pass.status)
								: chalk.yellow(pass.status);
					const mutations =
						pass.mutationsApplied !== null
							? `${pass.mutationsApplied}ok/${pass.mutationsSkipped ?? 0}skip/${pass.mutationsFailed ?? 0}err`
							: "-";
					console.log(
						`  ${status.padEnd(12 + (status.length - pass.status.length))}${pass.mode.padEnd(14)}${mutations.padEnd(24)}${pass.startedAt}`,
					);
					if (pass.summary) {
						console.log(`  ${chalk.dim(pass.summary.slice(0, 100))}`);
					}
					if (pass.error) {
						console.log(`  ${chalk.red(pass.error.slice(0, 100))}`);
					}
				}
			}
			console.log();
		});

	dream
		.command("trigger")
		.description("Manually trigger a dreaming pass")
		.option("--compact", "Run in compaction mode (full graph cleanup)")
		.option("--wait-secs <seconds>", "Max seconds to wait for pass completion (default: 720)", "720")
		.action(async (opts: { compact?: boolean; waitSecs?: string }) => {
			const mode = opts.compact ? "compact" : "incremental";
			// Poll ceiling: default 720s (12 min) > default LLM timeout 300s.
			// Increase with --wait-secs if your dreaming.timeout config exceeds 5 min.
			const rawWait = (opts.waitSecs ?? "720").trim();
			const parsedWait = Number.parseInt(rawWait, 10);
			if (!/^\d+$/.test(rawWait) || Number.isNaN(parsedWait) || parsedWait <= 0) {
				console.error(
					chalk.red(`  Invalid --wait-secs value: "${opts.waitSecs}" (must be a positive integer, e.g. 720)`),
				);
				process.exit(1);
			}
			const maxWait = Math.max(30, parsedWait);
			const pollInterval = 5_000;
			const maxPolls = Math.ceil((maxWait * 1000) / pollInterval);
			console.log(chalk.dim(`\n  Triggering ${mode} dreaming pass...\n`));

			const accepted = await deps.fetchFromDaemon<TriggerAccepted>("/api/dream/trigger", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ mode }),
			});

			if (!accepted) {
				console.error(chalk.red("Failed to trigger dreaming pass (is the daemon running?)"));
				process.exit(1);
			}

			if (accepted.error) {
				console.error(chalk.red(`  Error: ${accepted.error}`));
				process.exit(1);
			}

			console.log(chalk.dim(`  Pass ${accepted.passId} accepted, polling for result...\n`));

			// Poll status until the pass completes or fails
			let pass: DreamPass | undefined;
			for (let i = 0; i < maxPolls; i++) {
				await new Promise((r) => setTimeout(r, pollInterval));
				const status = await deps.fetchFromDaemon<DreamStatus>("/api/dream/status");
				if (!status) break;
				pass = status.passes.find((p) => p.id === accepted.passId);
				if (pass && pass.status !== "running") break;
			}

			if (!pass) {
				console.log(chalk.yellow("  Could not retrieve pass result. Check `signet dream status`."));
				console.log();
				return;
			}

			if (pass.status === "failed") {
				console.error(chalk.red("  Dreaming pass failed"));
				if (pass.error) console.error(chalk.red(`  Error: ${pass.error}`));
				process.exit(1);
			}

			console.log(chalk.green("  Dreaming pass complete"));
			console.log(`  ${chalk.dim("Pass ID:")}    ${pass.id}`);
			console.log(`  ${chalk.dim("Applied:")}    ${pass.mutationsApplied ?? 0} mutations`);
			console.log(`  ${chalk.dim("Skipped:")}    ${pass.mutationsSkipped ?? 0} mutations`);
			console.log(`  ${chalk.dim("Failed:")}     ${pass.mutationsFailed ?? 0} mutations`);
			if (pass.summary) console.log(`  ${chalk.dim("Summary:")}    ${pass.summary}`);
			console.log();
		});
}

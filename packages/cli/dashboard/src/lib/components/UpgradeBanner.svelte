<script lang="ts">
	import { browser } from "$app/environment";
	import type { DaemonStatus } from "$lib/api";
	import X from "@lucide/svelte/icons/x";

	const STORAGE_KEY_PREFIX = "signet-upgrade-banner-dismissed-";

	interface Props {
		daemonStatus: DaemonStatus | null;
	}

	let { daemonStatus }: Props = $props();

	let dismissed = $state(false);

	const version = $derived(daemonStatus?.version ?? null);
	const storageKey = $derived(version ? `${STORAGE_KEY_PREFIX}${version}` : null);

	// Check if this version's banner was already dismissed
	if (browser && storageKey) {
		dismissed = localStorage.getItem(storageKey) === "true";
	}

	// Show banner when version is known and not dismissed for this version
	const visible = $derived(
		!!version && version !== "0.0.0" && !dismissed,
	);

	function dismiss() {
		dismissed = true;
		if (browser && storageKey) {
			localStorage.setItem(storageKey, "true");
		}
	}
</script>

{#if visible}
	<div class="banner">
		<span class="banner-accent" aria-hidden="true"></span>
		<span class="banner-version">v{version}</span>
		<span class="banner-separator" aria-hidden="true"></span>
		<span class="banner-text">
			Knowledge graph, session continuity, constellation entity overlay
		</span>
		<button
			onclick={dismiss}
			class="banner-dismiss"
			aria-label="Dismiss upgrade banner"
		>
			<X class="size-3" />
		</button>
	</div>
{/if}

<style>
	.banner {
		display: flex;
		align-items: center;
		gap: 8px;
		height: 24px;
		padding: 0 12px;
		background: var(--sig-bg);
		border-bottom: 1px solid var(--sig-border);
		font-family: var(--font-mono);
		font-size: 9px;
		letter-spacing: 0.06em;
		flex-shrink: 0;
	}

	.banner-accent {
		width: 3px;
		height: 10px;
		background: var(--sig-highlight);
		border-radius: 1px;
		flex-shrink: 0;
	}

	.banner-version {
		color: var(--sig-highlight);
		font-weight: 700;
		text-transform: uppercase;
		flex-shrink: 0;
	}

	.banner-separator {
		width: 1px;
		height: 8px;
		background: var(--sig-border-strong);
		flex-shrink: 0;
	}

	.banner-text {
		color: var(--sig-text-muted);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		min-width: 0;
	}

	.banner-dismiss {
		margin-left: auto;
		display: flex;
		align-items: center;
		justify-content: center;
		width: 18px;
		height: 18px;
		flex-shrink: 0;
		color: var(--sig-text-muted);
		background: none;
		border: none;
		border-radius: 2px;
		cursor: pointer;
		transition: color var(--dur) var(--ease), background var(--dur) var(--ease);
	}

	.banner-dismiss:hover {
		color: var(--sig-text-bright);
		background: var(--sig-surface-raised);
	}
</style>

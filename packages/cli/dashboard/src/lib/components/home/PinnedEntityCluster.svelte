<script lang="ts">
	import { setTab } from "$lib/stores/navigation.svelte";
	import Network from "@lucide/svelte/icons/network";
	import { onMount } from "svelte";

	const isDev = import.meta.env.DEV;
	const API_BASE = isDev ? "http://localhost:3850" : "";

	interface PinnedEntity {
		id: string;
		name: string;
		type?: string;
		mentionCount?: number;
	}

	let entities = $state<PinnedEntity[]>([]);
	let loaded = $state(false);

	async function fetchPinned(): Promise<void> {
		try {
			const res = await fetch(`${API_BASE}/api/knowledge/entities?pinned=true&limit=6`);
			if (res.ok) {
				const data = await res.json();
				entities = data.entities ?? data.items ?? [];
			}
		} catch {
			// endpoint may not exist yet
		}
		loaded = true;
	}

	onMount(() => {
		fetchPinned();
	});
</script>

<div class="panel sig-panel">
	<div class="panel-header sig-panel-header">
		<span class="panel-title">SPOTLIGHT</span>
		<span class="panel-count">{entities.length} PINNED</span>
	</div>

	<div class="panel-body">
		{#if !loaded}
			<div class="empty-state">LOADING</div>
		{:else if entities.length === 0}
			<div class="empty-state">
				<Network class="empty-icon" />
				<span>PIN AN ENTITY IN KNOWLEDGE<br/>TO SET YOUR SPOTLIGHT</span>
			</div>
		{:else}
			<div class="entity-list">
				{#each entities as entity, idx (entity.id ?? `entity-${idx}`)}
					<div class="entity-row">
						<span class="entity-idx">{String(idx + 1).padStart(2, "0")}</span>
						<span
							class="entity-dot"
							style="background: var(--sig-highlight)"
						></span>
						<span class="entity-name">{entity.name}</span>
						{#if entity.mentionCount !== undefined}
							<span class="entity-count">{entity.mentionCount}</span>
						{/if}
					</div>
				{/each}
			</div>
		{/if}
	</div>

	<div class="panel-footer sig-panel-footer">
		<button class="panel-link" onclick={() => setTab("knowledge")}>
			VIEW IN KNOWLEDGE
		</button>
	</div>
</div>

<style>
	.panel {
		display: flex;
		flex-direction: column;
		height: 100%;
		background: var(--sig-surface);
	}

	.panel-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: var(--space-sm) var(--space-md);
		flex-shrink: 0;
	}

	.panel-title {
		font-family: var(--font-display);
		font-size: 11px;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.1em;
		color: var(--sig-text-bright);
	}

	.panel-count {
		font-family: var(--font-mono);
		font-size: 8px;
		letter-spacing: 0.1em;
		color: var(--sig-text-muted);
	}

	.panel-body {
		flex: 1;
		min-height: 0;
		overflow-y: auto;
		padding: var(--space-sm) 0;
	}

	.panel-footer {
		padding: var(--space-sm) var(--space-md);
		flex-shrink: 0;
	}

	.panel-link {
		font-family: var(--font-mono);
		font-size: 9px;
		letter-spacing: 0.08em;
		color: var(--sig-accent);
		background: none;
		border: none;
		padding: 0;
		cursor: pointer;
		transition: color var(--dur) var(--ease);
	}

	.panel-link:hover {
		color: var(--sig-highlight-text);
	}

	/* Entity list */
	.entity-list {
		display: flex;
		flex-direction: column;
	}

	.entity-row {
		display: flex;
		align-items: center;
		gap: 6px;
		padding: 3px var(--space-md);
		font-family: var(--font-mono);
		font-size: 10px;
		transition: background var(--dur) var(--ease);
	}

	.entity-row:hover {
		background: var(--sig-surface-raised);
	}

	.entity-idx {
		width: 16px;
		flex-shrink: 0;
		color: var(--sig-highlight);
		opacity: 0.4;
		font-size: 9px;
		font-variant-numeric: tabular-nums;
	}

	.entity-dot {
		width: 4px;
		height: 4px;
		border-radius: 50%;
		flex-shrink: 0;
	}

	.entity-name {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		color: var(--sig-text);
	}

	.entity-count {
		flex-shrink: 0;
		font-size: 9px;
		color: var(--sig-text-muted);
		font-variant-numeric: tabular-nums;
	}

	/* Empty state */
	.empty-state {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: var(--space-sm);
		height: 100%;
		font-family: var(--font-mono);
		font-size: 9px;
		letter-spacing: 0.08em;
		color: var(--sig-text-muted);
		text-align: center;
		line-height: 1.6;
		padding: var(--space-md);
	}

	:global(.panel .empty-icon) {
		width: 16px;
		height: 16px;
		color: var(--sig-border-strong);
	}
</style>

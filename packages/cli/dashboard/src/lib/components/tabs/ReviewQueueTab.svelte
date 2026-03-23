<script lang="ts">
	import { onMount } from "svelte";
	import { Badge } from "$lib/components/ui/badge/index.js";
	import { Button } from "$lib/components/ui/button/index.js";
	import PageBanner from "$lib/components/layout/PageBanner.svelte";
	import TabGroupBar from "$lib/components/layout/TabGroupBar.svelte";
	import { ENGINE_TAB_ITEMS } from "$lib/components/layout/page-headers";
	import { nav } from "$lib/stores/navigation.svelte";
	import { focusEngineTab } from "$lib/stores/tab-group-focus.svelte";

	interface ReviewItem {
		id: string;
		memory_id: string;
		event: "DEDUP" | "REVIEW_NEEDED" | "BLOCKED_DESTRUCTIVE";
		old_content: string | null;
		new_content: string | null;
		reason: string | null;
		metadata: string | null;
		created_at: string;
		session_id: string | null;
		current_content: string | null;
		memory_type: string | null;
		importance: number | null;
	}

	let items = $state<ReviewItem[]>([]);
	let loading = $state(true);
	let error = $state<string | null>(null);
	let expandedId = $state<string | null>(null);

	async function load() {
		loading = true;
		error = null;
		try {
			const res = await fetch("/api/memory/review-queue");
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const data = (await res.json()) as { items: ReviewItem[]; total: number };
			items = data.items;
		} catch (e) {
			error = e instanceof Error ? e.message : "Failed to load review queue";
		} finally {
			loading = false;
		}
	}

	function relativeTime(iso: string): string {
		const diff = Date.now() - new Date(iso).getTime();
		const m = Math.floor(diff / 60_000);
		if (m < 1) return "just now";
		if (m < 60) return `${m}m ago`;
		const h = Math.floor(m / 60);
		if (h < 24) return `${h}h ago`;
		return `${Math.floor(h / 24)}d ago`;
	}

	function eventLabel(event: ReviewItem["event"]): string {
		if (event === "DEDUP") return "Deduped";
		if (event === "BLOCKED_DESTRUCTIVE") return "Blocked";
		return "Review";
	}

	function eventVariant(event: ReviewItem["event"]): "default" | "secondary" | "destructive" | "outline" {
		if (event === "BLOCKED_DESTRUCTIVE") return "destructive";
		if (event === "REVIEW_NEEDED") return "default";
		return "secondary";
	}

	function toggle(id: string) {
		expandedId = expandedId === id ? null : id;
	}

	onMount(load);
</script>

<PageBanner title="Review Queue">
	<TabGroupBar
		group="engine"
		tabs={ENGINE_TAB_ITEMS}
		activeTab={nav.activeTab}
		onselect={(_tab, index) => focusEngineTab(index)}
	/>
</PageBanner>

<div class="flex flex-col flex-1 overflow-hidden">
	<div class="flex items-center justify-between px-4 py-2 border-b border-[var(--sig-border)]">
		<span class="sig-label text-[var(--sig-text-muted)]">
			{loading ? "Loading…" : `${items.length} events · last 30 days`}
		</span>
		<Button variant="outline" size="sm" onclick={load} disabled={loading}>Refresh</Button>
	</div>

	<div class="flex-1 overflow-y-auto p-4 space-y-2">
		{#if loading}
			<div class="flex items-center justify-center h-32 sig-label text-[var(--sig-text-muted)]">
				Loading review queue…
			</div>
		{:else if error}
			<div class="flex items-center justify-center h-32 sig-label text-[var(--sig-danger)]">
				{error}
			</div>
		{:else if items.length === 0}
			<div class="flex flex-col items-center justify-center h-32 gap-2">
				<span class="sig-label text-[var(--sig-text-muted)]">No pipeline review events in the last 30 days.</span>
				<span class="text-xs text-[var(--sig-text-faint)]">Deduplication and blocked events will appear here as the pipeline runs.</span>
			</div>
		{:else}
			{#each items as item (item.id)}
				<!-- svelte-ignore a11y_no_static_element_interactions -->
				<div
					class="border border-[var(--sig-border)] rounded bg-[var(--sig-surface)] overflow-hidden cursor-pointer"
					onclick={() => toggle(item.id)}
					onkeydown={(e) => { if (e.key === "Enter" || e.key === " ") toggle(item.id); }}
					role="button"
					tabindex="0"
				>
					<div class="flex items-start gap-3 px-3 py-2.5">
						<Badge variant={eventVariant(item.event)} class="shrink-0 mt-0.5 text-[10px] uppercase">
							{eventLabel(item.event)}
						</Badge>
						<div class="flex-1 min-w-0">
							<p class="text-xs text-[var(--sig-text)] truncate font-[family-name:var(--font-mono)]">
								{item.new_content ?? item.old_content ?? item.current_content ?? "—"}
							</p>
							{#if item.reason}
								<p class="text-[10px] text-[var(--sig-text-muted)] mt-0.5 truncate">{item.reason}</p>
							{/if}
						</div>
						<span class="shrink-0 text-[10px] text-[var(--sig-text-faint)] tabular-nums">
							{relativeTime(item.created_at)}
						</span>
					</div>

					{#if expandedId === item.id}
						<div class="border-t border-[var(--sig-border)] bg-[var(--sig-surface-raised)] px-3 py-2.5 space-y-3">
							{#if item.old_content}
								<div>
									<p class="text-[10px] uppercase tracking-wide text-[var(--sig-text-muted)] mb-1">Existing memory</p>
									<p class="text-xs text-[var(--sig-text)] font-[family-name:var(--font-mono)] whitespace-pre-wrap">{item.old_content}</p>
								</div>
							{/if}
							{#if item.new_content}
								<div>
									<p class="text-[10px] uppercase tracking-wide text-[var(--sig-text-muted)] mb-1">Proposed fact</p>
									<p class="text-xs text-[var(--sig-text)] font-[family-name:var(--font-mono)] whitespace-pre-wrap">{item.new_content}</p>
								</div>
							{/if}
							{#if item.current_content && !item.old_content}
								<div>
									<p class="text-[10px] uppercase tracking-wide text-[var(--sig-text-muted)] mb-1">Current stored value</p>
									<p class="text-xs text-[var(--sig-text)] font-[family-name:var(--font-mono)] whitespace-pre-wrap">{item.current_content}</p>
								</div>
							{/if}
							<div class="flex flex-wrap gap-4 text-[10px] text-[var(--sig-text-faint)]">
								{#if item.memory_id}
									<span>id: <span class="font-[family-name:var(--font-mono)]">{item.memory_id.slice(0, 8)}</span></span>
								{/if}
								{#if item.memory_type}
									<span>type: {item.memory_type}</span>
								{/if}
								{#if item.importance != null}
									<span>importance: {item.importance.toFixed(2)}</span>
								{/if}
								{#if item.session_id}
									<span>session: <span class="font-[family-name:var(--font-mono)]">{item.session_id.slice(0, 8)}</span></span>
								{/if}
							</div>
						</div>
					{/if}
				</div>
			{/each}
		{/if}
	</div>
</div>

<script lang="ts">
import { type TabId, isMemoryGroup, isEngineGroup } from "$lib/stores/navigation.svelte";
import { PAGE_HEADERS, MEMORY_TAB_ITEMS, ENGINE_TAB_ITEMS } from "./page-headers";
import TabGroupBar from "./TabGroupBar.svelte";
import { Button } from "$lib/components/ui/button/index.js";
import * as Sidebar from "$lib/components/ui/sidebar/index.js";
import Plus from "@lucide/svelte/icons/plus";

interface Props {
	activeTab: TabId;
	memoryDocumentsLabel: string;
	memorySearching: boolean;
	memoryHasResults: boolean;
	onresetmemory: () => void;
	onnewtask: () => void;
	onmemoryselect: (tab: TabId, index: number) => void;
	onengineselect: (tab: TabId, index: number) => void;
}

const {
	activeTab,
	memoryDocumentsLabel,
	memorySearching,
	memoryHasResults,
	onresetmemory,
	onnewtask,
	onmemoryselect,
	onengineselect,
}: Props = $props();
</script>

<header
	class="flex h-12 shrink-0 items-center justify-between
		border-b border-[var(--sig-border)] px-4"
>
	<div class="flex items-center gap-2">
		<Sidebar.Trigger class="-ml-1" />
		<span class="sig-heading">
			{PAGE_HEADERS[activeTab].title}
		</span>
		{#if !isMemoryGroup(activeTab) && !isEngineGroup(activeTab)}
			<span class="sig-eyebrow tracking-[0.1em]">&middot;</span>
			<span class="sig-eyebrow tracking-[0.1em]">
				{PAGE_HEADERS[activeTab].eyebrow}
			</span>
		{/if}

		{#if isMemoryGroup(activeTab)}
			<TabGroupBar
				group="memory"
				tabs={MEMORY_TAB_ITEMS}
				{activeTab}
				onselect={onmemoryselect}
			/>
		{:else if isEngineGroup(activeTab)}
			<TabGroupBar
				group="engine"
				tabs={ENGINE_TAB_ITEMS}
				{activeTab}
				onselect={onengineselect}
			/>
		{/if}
	</div>
	<div class="flex items-center gap-3">
		{#if activeTab === "memory"}
			<span class="sig-label">
				{memoryDocumentsLabel}
			</span>
			{#if memorySearching}
				<span class="sig-label">
					searching...
				</span>
			{/if}
			{#if memoryHasResults}
				<Button
					variant="ghost"
					size="sm"
					class="sig-label text-[var(--sig-accent)] hover:underline p-0 h-auto"
					onclick={onresetmemory}
				>
					Reset
				</Button>
			{/if}
		{:else if activeTab === "timeline"}
			<span class="sig-label">
				Era timeline
			</span>
		{:else if activeTab === "pipeline"}
			<span class="sig-label">
				Memory loop
			</span>
		{:else if activeTab === "embeddings"}
			<span class="sig-label">
				Constellation
			</span>
		{:else if activeTab === "knowledge"}
			<span class="sig-label">
				Knowledge graph
			</span>
		{:else if activeTab === "tasks"}
			<Button
				variant="outline"
				size="sm"
				class="h-7 gap-1.5 text-[11px]"
				onclick={onnewtask}
			>
				<Plus class="size-3.5" />
				New Task
			</Button>
		{/if}
	</div>
</header>

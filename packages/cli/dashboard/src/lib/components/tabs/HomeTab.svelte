<script lang="ts">
	import type {
		DaemonStatus,
		Identity,
		Memory,
		MemoryStats,
		Harness,
		DiagnosticsReport,
		ContinuityEntry,
		PipelineStatus,
		DocumentConnector,
	} from "$lib/api";
	import {
		getDiagnostics,
		getHomeGreeting,
		getContinuityLatest,
		getPipelineStatus,
		getConnectors,
	} from "$lib/api";
	import AgentHeader from "$lib/components/home/AgentHeader.svelte";
	import SuggestedInsights from "$lib/components/home/SuggestedInsights.svelte";
	import PredictorSplitBar from "$lib/components/home/PredictorSplitBar.svelte";
	import PinnedEntityCluster from "$lib/components/home/PinnedEntityCluster.svelte";
	import { onMount } from "svelte";

	interface Props {
		identity: Identity;
		memories: Memory[];
		memoryStats: MemoryStats | null;
		harnesses: Harness[];
		daemonStatus: DaemonStatus | null;
	}

	const { identity, memories, memoryStats, harnesses, daemonStatus }: Props =
		$props();

	let diagnostics = $state<DiagnosticsReport | null>(null);
	let greeting = $state<string>("welcome back");
	let continuity = $state<ContinuityEntry[]>([]);
	let pipelineStatus = $state<PipelineStatus | null>(null);
	let connectors = $state<DocumentConnector[]>([]);
	let loaded = $state(false);

	onMount(async () => {
		const results = await Promise.allSettled([
			getDiagnostics(),
			getHomeGreeting(),
			getContinuityLatest(),
			getPipelineStatus(),
			getConnectors(),
		]);

		if (results[0].status === "fulfilled" && results[0].value)
			diagnostics = results[0].value;
		if (results[1].status === "fulfilled" && results[1].value)
			greeting = results[1].value.greeting;
		if (results[2].status === "fulfilled")
			continuity = results[2].value;
		if (results[3].status === "fulfilled")
			pipelineStatus = results[3].value;
		if (results[4].status === "fulfilled")
			connectors = results[4].value;
		loaded = true;
	});
</script>

<div class="flex flex-col flex-1 min-h-0 overflow-hidden">
<div class="home-grid">
	<div class="area-banner">
		<AgentHeader
			{identity}
			{greeting}
			{daemonStatus}
			connectorCount={connectors.length}
			{continuity}
			memoryCount={memoryStats?.total ?? 0}
			{diagnostics}
			{pipelineStatus}
			{memoryStats}
		/>
	</div>
	<div class="area-insights">
		<SuggestedInsights {memories} />
	</div>
	<div class="area-sidebar">
		<PinnedEntityCluster />
		<PredictorSplitBar {daemonStatus} />
	</div>
</div>
</div>

<style>
	.home-grid {
		display: grid;
		grid-template-columns: 1.6fr 1fr;
		grid-template-rows: auto 1fr;
		grid-template-areas:
			"banner  banner"
			"insights sidebar";
		gap: var(--space-sm);
		flex: 1;
		min-height: 0;
		padding: var(--space-sm);
		overflow: hidden;
	}

	.area-banner {
		grid-area: banner;
	}

	.area-insights {
		grid-area: insights;
		min-height: 0;
		overflow: hidden;
	}

	.area-sidebar {
		grid-area: sidebar;
		display: flex;
		flex-direction: column;
		gap: var(--space-sm);
		min-height: 0;
		overflow: hidden;
	}

	.area-sidebar > :global(*) {
		flex: 1;
		min-width: 0;
		min-height: 0;
	}
</style>

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
		fetchChangelog,
	} from "$lib/api";
	import AgentHeader from "$lib/components/home/AgentHeader.svelte";
	import SuggestedInsights from "$lib/components/home/SuggestedInsights.svelte";
	import PredictorSplitBar from "$lib/components/home/PredictorSplitBar.svelte";
	import PinnedEntityCluster from "$lib/components/home/PinnedEntityCluster.svelte";
	import SystemInfoCard from "$lib/components/home/SystemInfoCard.svelte";
	import MiniChangelog from "$lib/components/home/MiniChangelog.svelte";
	import QuickLinks from "$lib/components/home/QuickLinks.svelte";
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
	let changelogHtml = $state<string | null>(null);
	let loaded = $state(false);

	onMount(async () => {
		const results = await Promise.allSettled([
			getDiagnostics(),
			getHomeGreeting(),
			getContinuityLatest(),
			getPipelineStatus(),
			getConnectors(),
			fetchChangelog(),
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
		if (results[5].status === "fulfilled" && results[5].value)
			changelogHtml = results[5].value.html;
		loaded = true;
	});
</script>

<div class="home-grid">
	<div class="area-banner">
		<AgentHeader
			{identity}
			{greeting}
			{daemonStatus}
			connectorCount={connectors.length}
			{continuity}
			memoryCount={memoryStats?.total ?? 0}
		/>
	</div>

	<div class="area-insights">
		<SuggestedInsights {memories} />
	</div>

	<div class="area-predictor">
		<PredictorSplitBar {daemonStatus} />
	</div>

	<div class="area-entity">
		<PinnedEntityCluster />
	</div>

	<div class="area-health">
		<SystemInfoCard
			{diagnostics}
			{pipelineStatus}
			{memoryStats}
		/>
	</div>

	<div class="area-links">
		<QuickLinks />
	</div>

	<div class="area-changelog">
		<MiniChangelog html={changelogHtml} />
	</div>
</div>

<style>
	.home-grid {
		display: grid;
		grid-template-columns: 1.6fr 1fr;
		grid-template-rows: auto 1fr 1fr auto auto;
		grid-template-areas:
			"banner     banner"
			"insights   predictor"
			"insights   entity"
			"health     entity"
			"links      changelog";
		gap: var(--space-sm);
		height: 100%;
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

	.area-predictor {
		grid-area: predictor;
	}

	.area-entity {
		grid-area: entity;
		min-height: 0;
		overflow: hidden;
	}

	.area-health {
		grid-area: health;
	}

	.area-links {
		grid-area: links;
	}

	.area-changelog {
		grid-area: changelog;
		min-height: 0;
		overflow: hidden;
	}
</style>

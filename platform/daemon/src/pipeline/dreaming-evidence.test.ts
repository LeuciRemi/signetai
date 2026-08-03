import { describe, expect, it } from "bun:test";
import type { EpisodicSourceRecord } from "../episodic-sources";
import { createDreamingAgentEvidence, renderDreamingEvidence } from "./dreaming-evidence";

const SOURCE: EpisodicSourceRecord = {
	kind: "memory",
	id: "memory-1",
	content: "Signet consolidates immutable evidence.",
	sourceKind: "manual",
	sourceId: "memory-1",
	sourcePath: null,
	sourceEntryId: null,
	project: "signet",
	harness: "pi",
	capturedAt: "2026-08-03T00:00:00.000Z",
	evidenceMeta: JSON.stringify({ aspects: [{ entityName: "Signet", aspect: "architecture" }] }),
};

describe("dreaming evidence", () => {
	it("uses the same rendered structured evidence for prompts and agent citations", () => {
		const rendered = renderDreamingEvidence(SOURCE);
		const evidence = createDreamingAgentEvidence([SOURCE]);
		expect(rendered).toContain("structured_evidence:");
		expect(evidence).toEqual([
			expect.objectContaining({
				content: rendered,
				sourceRef: "memory:memory-1",
				sourceKind: "manual",
				sourceId: "memory-1",
			}),
		]);
	});
});

import { describe, expect, it } from "bun:test";
import type { LlmProvider } from "./provider";
import { enrichSkillFrontmatter } from "./skill-enrichment";

function mockProvider(raw: string): LlmProvider {
	return {
		name: "mock",
		async available() {
			return true;
		},
		async generate() {
			return raw;
		},
	};
}

describe("enrichSkillFrontmatter", () => {
	it("parses enrichment JSON wrapped in prose", async () => {
		const provider = mockProvider(
			'We need to output JSON only.\n\n{"description":"Best practices for Remotion video creation and dynamic media generation.","triggers":["build remotion animation","make video composition"],"tags":["video","animation"]}',
		);

		const result = await enrichSkillFrontmatter(
			{
				name: "remotion-best-practices",
				description: "",
				body: "Skill about Remotion workflows and animation patterns.",
			},
			provider,
		);

		expect(result).not.toBeNull();
		expect(result?.description).toContain("Remotion");
		expect(result?.triggers).toContain("build remotion animation");
		expect(result?.tags).toContain("video");
	});

	it("parses fenced JSON with trailing commas", async () => {
		const provider = mockProvider(`\`\`\`json
{
  "description": "Guidance for creating and optimizing Remotion compositions.",
  "triggers": ["render remotion videos", "optimize remotion compositions",],
  "tags": ["video", "performance",]
}
\`\`\``);

		const result = await enrichSkillFrontmatter(
			{
				name: "remotion-best-practices",
				description: "",
				body: "Skill details",
			},
			provider,
		);

		expect(result).not.toBeNull();
		expect(result?.triggers.length).toBe(2);
		expect(result?.tags).toContain("performance");
	});

	it("prefers final enrichment object over earlier example objects", async () => {
		const provider = mockProvider(
			'Example: {"description":"","triggers":[],"tags":[]}\nFinal: {"description":"Practical guidance for producing Remotion compositions with reusable patterns.","triggers":["build remotion video"],"tags":["video"]}',
		);

		const result = await enrichSkillFrontmatter(
			{
				name: "remotion-best-practices",
				description: "",
				body: "Skill details",
			},
			provider,
		);

		expect(result).not.toBeNull();
		expect(result?.description).toContain("Remotion");
		expect(result?.triggers).toContain("build remotion video");
	});
});

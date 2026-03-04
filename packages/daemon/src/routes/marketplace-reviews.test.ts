import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { mountMarketplaceReviewsRoutes } from "./marketplace-reviews.js";

describe("marketplace reviews routes", () => {
	const tmpAgentsDir = join(tmpdir(), `signet-marketplace-reviews-route-test-${process.pid}`);
	let origSignetPath: string | undefined;
	let app: Hono;

	beforeEach(() => {
		origSignetPath = process.env.SIGNET_PATH;
		process.env.SIGNET_PATH = tmpAgentsDir;
		mkdirSync(tmpAgentsDir, { recursive: true });

		app = new Hono();
		mountMarketplaceReviewsRoutes(app);
	});

	afterEach(() => {
		process.env.SIGNET_PATH = origSignetPath;
		if (existsSync(tmpAgentsDir)) {
			rmSync(tmpAgentsDir, { recursive: true, force: true });
		}
	});

	it("creates and lists reviews for a target", async () => {
		const createRes = await app.request("/api/marketplace/reviews", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				targetType: "skill",
				targetId: "skills.sh/foo",
				displayName: "avery",
				rating: 5,
				title: "Great",
				body: "Does the job",
			}),
		});

		expect(createRes.status).toBe(200);
		const createBody = (await createRes.json()) as { success: boolean };
		expect(createBody.success).toBe(true);

		const listRes = await app.request("/api/marketplace/reviews?type=skill&id=skills.sh%2Ffoo");
		expect(listRes.status).toBe(200);
		const listBody = (await listRes.json()) as {
			reviews: Array<{ targetType: string; targetId: string; rating: number }>;
			total: number;
			summary: { count: number; avgRating: number };
		};

		expect(listBody.total).toBe(1);
		expect(listBody.reviews[0]?.targetType).toBe("skill");
		expect(listBody.reviews[0]?.targetId).toBe("skills.sh/foo");
		expect(listBody.summary.count).toBe(1);
		expect(listBody.summary.avgRating).toBe(5);
	});

	it("updates review sync config", async () => {
		const patchRes = await app.request("/api/marketplace/reviews/config", {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ enabled: true, endpointUrl: "https://example.com/reviews" }),
		});

		expect(patchRes.status).toBe(200);
		const patchBody = (await patchRes.json()) as {
			success: boolean;
			config: { enabled: boolean; endpointUrl: string };
		};
		expect(patchBody.success).toBe(true);
		expect(patchBody.config.enabled).toBe(true);
		expect(patchBody.config.endpointUrl).toBe("https://example.com/reviews");
	});
});

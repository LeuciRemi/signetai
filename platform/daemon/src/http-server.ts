import { createAdaptorServer } from "@hono/node-server";

type AdaptorServerOptions = Parameters<typeof createAdaptorServer>[0];

export type SignetHttpServerOptions = AdaptorServerOptions;

export function createSignetHttpServer(opts: SignetHttpServerOptions): ReturnType<typeof createAdaptorServer> {
	const options: AdaptorServerOptions = {
		...opts,
		// Hono's node adapter swaps global Request/Response by default.
		// @huggingface/transformers checks `response instanceof Response`
		// before caching downloaded model files, so replacing Response makes
		// native embedding model downloads fail with:
		// "Unable to get model file path or buffer."
		overrideGlobalObjects: false,
	};
	return createAdaptorServer(options);
}

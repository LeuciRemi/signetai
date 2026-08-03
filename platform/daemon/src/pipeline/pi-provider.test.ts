import { describe, expect, test } from "bun:test";
import { type Api, type Model, getModels } from "@earendil-works/pi-ai";
import { githubCopilotOAuthProvider } from "@earendil-works/pi-ai/oauth";
import * as Type from "typebox";
import { createPiModelProvider, isPiAgentSessionProvider, resolvePiModel, withAgentToolCallLimit } from "./pi-provider";

describe("pi provider catalog models", () => {
	test("preserves the Codex responses API and registry metadata", () => {
		const model = getModels("openai-codex").find((candidate) => candidate.id === "gpt-5.4");
		expect(model).toBeDefined();
		const resolved = resolvePiModel({
			executor: "openai-codex",
			providerFamily: "openai-codex",
			model: "gpt-5.4",
			piModel: model as Model<Api>,
			apiKey: "oauth-access",
		});

		expect(resolved.piModel.api).toBe("openai-codex-responses");
		expect(resolved.piModel.baseUrl).toBe("https://chatgpt.com/backend-api");
		expect(resolved.apiKey).toBe("oauth-access");
	});

	test("preserves Copilot headers and applies credential-dependent model changes", () => {
		const models = getModels("github-copilot") as Model<Api>[];
		const modified = githubCopilotOAuthProvider.modifyModels?.(models, {
			refresh: "refresh",
			access: "tid=1;proxy-ep=proxy.enterprise.example.com;exp=9999999999",
			expires: Date.now() + 60_000,
		});
		const model = modified?.[0];
		expect(model).toBeDefined();
		if (!model) throw new Error("Copilot catalog model missing");
		const resolved = resolvePiModel({
			executor: "github-copilot",
			providerFamily: "github-copilot",
			model: model.id,
			piModel: model,
			apiKey: "copilot-access",
		});

		expect(resolved.piModel.baseUrl).toBe("https://api.enterprise.example.com");
		expect(resolved.piModel.headers?.["Copilot-Integration-Id"]).toBe("vscode-chat");
	});

	test("creates an isolated AgentSession with no ambient tools", async () => {
		const provider = createPiModelProvider({
			executor: "openai-compatible",
			model: "test-model",
			baseUrl: "http://127.0.0.1:1234/v1",
		});
		expect(isPiAgentSessionProvider(provider)).toBe(true);
		const session = await provider.createAgentSession([]);
		try {
			expect(session.getActiveToolNames()).toEqual([]);
		} finally {
			session.dispose();
		}
	});

	test("stops dispatching tools after the daemon-owned session budget", async () => {
		let executed = 0;
		let exhausted = 0;
		const [tool] = withAgentToolCallLimit(
			[
				{
					name: "inspect",
					label: "Inspect",
					description: "Inspect scoped state",
					parameters: Type.Object({}),
					async execute() {
						executed++;
						return { content: [{ type: "text" as const, text: "ok" }], details: {} };
					},
				},
			],
			1,
			() => exhausted++,
		);
		if (!tool) throw new Error("Expected bounded tool");
		const invoke = () => tool.execute("call", {}, undefined, undefined, undefined as never);

		await invoke();
		const limited = await invoke();

		expect(executed).toBe(1);
		expect(exhausted).toBe(1);
		expect(limited.content).toEqual([{ type: "text", text: "Tool-call limit (1) reached; stop this maintenance pass." }]);
	});
});

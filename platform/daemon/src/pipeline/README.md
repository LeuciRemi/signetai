# Pipeline prompt testing

Live Ollama prompt checks for the cross-entity dependency synthesis prompt
live in `dependency-synthesis.test.ts`. The retired per-fact structural
dependency worker (`structural-dependency.ts`) and its prompt test were
removed under Dreaming (#946).

Model selection uses `SIGNET_OLLAMA_TEST_MODEL`.

Examples:

```bash
# Root script alias
bun run test:prompt:synthesis

# Cross-entity dependency synthesis prompt, default local baseline
SIGNET_OLLAMA_TEST_MODEL=qwen3:4b \
bun test platform/daemon/src/pipeline/dependency-synthesis.test.ts

# Cross-entity dependency synthesis prompt, Nemotron
SIGNET_OLLAMA_TEST_MODEL=nemotron-3-nano:4b \
bun test platform/daemon/src/pipeline/dependency-synthesis.test.ts
```

Notes:

- These are live model checks, not mocked unit tests.
- They require Ollama at `http://localhost:11434`.
- If the selected model is not pulled locally, the tests print a skip message.

import { describe, expect, it } from "bun:test"
import {
  buildSignetRecallQuery,
  formatSupermemoryParityContent,
  hasUsableMemoryContent,
  resolveSignetSearchLimit,
  SignetDreamingProvider,
  scopeStructuredBenchmarkParticipants,
} from "./index"
import type { UnifiedSession } from "../../types/unified"

describe("Signet benchmark profiles", () => {
  class CapturingDreamingProvider extends SignetDreamingProvider {
    calls: Array<{ path: string; init: RequestInit }> = []

    protected override async request<T>(path: string, init: RequestInit): Promise<T> {
      this.calls.push({ path, init })
      if (path === "/api/memory/remember") return { id: "episodic-1", embedded: true } as T
      if (path === "/api/dream/trigger") return { passId: "pass-1" } as T
      if (path === "/api/dream/status?agentId=memorybench") {
        return { worker: { running: true }, passes: [{ id: "pass-1", status: "completed" }] } as T
      }
      throw new Error(`Unexpected path ${path}`)
    }
  }

  it("keeps benchmark input episodic until one post-ingest Dreaming pass", async () => {
    const provider = new CapturingDreamingProvider()
    const session: UnifiedSession = {
      sessionId: "session-1",
      messages: [{ role: "user", content: "I moved deployment to edge runtime." }],
    }
    const previousPoll = process.env.SIGNET_BENCH_DREAMING_POLL_SECS
    process.env.SIGNET_BENCH_DREAMING_POLL_SECS = "0"
    try {
      await provider.ingest([session], { containerTag: "question-1-run" })
      await provider.finalizeIngest({ runId: "run", dataSourceRunId: "source" })
    } finally {
      if (previousPoll === undefined) delete process.env.SIGNET_BENCH_DREAMING_POLL_SECS
      else process.env.SIGNET_BENCH_DREAMING_POLL_SECS = previousPoll
    }

    expect(provider.name).toBe("signet-dreaming")
    const remember = provider.calls.find((call) => call.path === "/api/memory/remember")
    expect(JSON.parse(String(remember?.init.body))).toMatchObject({
      content: "user: I moved deployment to edge runtime.",
      tags: "memorybench,question-1-run,session-1,dreaming,raw-session",
    })
    expect(JSON.parse(String(remember?.init.body))).not.toHaveProperty("structured")
    expect(provider.calls.map((call) => call.path)).toEqual([
      "/api/memory/remember",
      "/api/dream/status?agentId=memorybench",
      "/api/dream/trigger",
      "/api/dream/status?agentId=memorybench",
    ])
  })

  it("formats raw sessions like the Supermemory adapter for parity runs", () => {
    const session: UnifiedSession = {
      sessionId: "session-1",
      messages: [
        { role: "user", content: "I use <Spotify> lately." },
        { role: "assistant", content: "Noted." },
      ],
      metadata: { formattedDate: "10:20 am on 20 May, 2023" },
    }

    const content = formatSupermemoryParityContent(session)

    expect(content).toContain(
      "Here is the date the following session took place: 10:20 am on 20 May, 2023"
    )
    expect(content).toContain("Here is the session as a stringified JSON:")
    expect(content).toContain("&lt;Spotify&gt;")
  })

  it("uses the harness limit for rules runs and Supermemory's hardcoded limit for parity runs", () => {
    expect(resolveSignetSearchLimit("structured", 10)).toBe(10)
    expect(resolveSignetSearchLimit("structured", undefined)).toBe(10)
    expect(resolveSignetSearchLimit("supermemory-parity", 10)).toBe(30)
  })

  it("adds absolute temporal hints for relative LongMemEval search questions", () => {
    const query = buildSignetRecallQuery(
      "I mentioned an investment for a competition four weeks ago? What did I buy?",
      "2023/04/01 (Sat) 08:30"
    )

    expect(query).toContain("Temporal search hints")
    expect(query).toContain("4 March 2023")
    expect(query).toContain("2023-03-04")
  })
})

describe("Signet structured ingestion guards", () => {
  it("rejects empty extracted memory content before calling remember", () => {
    expect(hasUsableMemoryContent("")).toBe(false)
    expect(hasUsableMemoryContent("  \n\t")).toBe(false)
    expect(hasUsableMemoryContent("User likes Paris.")).toBe(true)
  })

  it("scopes benchmark participant entities to the question container", () => {
    const scoped = scopeStructuredBenchmarkParticipants(
      {
        entities: [
          {
            source: "Benchmark User",
            sourceType: "person",
            relationship: "uses",
            target: "Spotify",
            targetType: "service",
            confidence: 0.9,
          },
        ],
        aspects: [
          {
            entityName: "Benchmark User",
            aspect: "music preferences",
            attributes: [{ content: "Benchmark User has been using Spotify lately." }],
          },
        ],
        hints: ["What streaming service has the benchmark user been using?"],
      },
      "question-1-run-1"
    )

    expect(scoped.entities[0]?.source).toBe("MemoryBench User question-1-run-1")
    expect(scoped.entities[0]?.target).toBe("Spotify")
    expect(scoped.aspects[0]?.entityName).toBe("MemoryBench User question-1-run-1")
  })
})

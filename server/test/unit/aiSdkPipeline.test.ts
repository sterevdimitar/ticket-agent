import { MockLanguageModelV4, simulateReadableStream } from "ai/test";
import { describe, expect, it } from "vitest";
import { aiSdkProvider } from "../../src/agent/geminiProvider.js";

/**
 * geminiProvider.test.ts mocks `streamText` itself, so the real AI SDK never runs
 * there. Two outages came from exactly that gap: v7's prompt standardization
 * rejecting system messages inside `messages`, and stream-part shape drift.
 *
 * These tests run the REAL `streamText` against a mock MODEL, so real prompt
 * standardization and real `fullStream` shaping execute; only the transport is
 * faked. Deliberately NOT covered here: anything provider-side (model retirement,
 * auth, quota — that stays with scripts/adversarial.ts) and the @ai-sdk/google
 * message converter, which the mock model replaces.
 */

/** Provider-level stream part, derived from the mock so no extra dependency is needed. */
type StreamPart = Awaited<ReturnType<MockLanguageModelV4["doStream"]>>["stream"] extends
  ReadableStream<infer P>
  ? P
  : never;

const FINISH: StreamPart = {
  type: "finish",
  // Provider-level finish reason is an object, not a bare string: the SDK carries
  // a `unified` reason alongside the provider's `raw` one.
  finishReason: { unified: "stop", raw: "STOP" },
  usage: {
    inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 1, text: 1, reasoning: 0 },
  },
};

/** The provider-level text protocol: start / delta* / end, all sharing one id. */
function textParts(...deltas: string[]): StreamPart[] {
  return [
    { type: "text-start", id: "t0" },
    ...deltas.map((delta): StreamPart => ({ type: "text-delta", id: "t0", delta })),
    { type: "text-end", id: "t0" },
  ];
}

/**
 * At this level `input` is a JSON *string* — the SDK parses and validates it on
 * the way to `fullStream`. Passing an object here would not exercise that path.
 */
function toolCallPart(toolCallId: string, toolName: string, input: unknown): StreamPart {
  return { type: "tool-call", toolCallId, toolName, input: JSON.stringify(input) };
}

function mockModel(parts: StreamPart[]): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    modelId: "mock-model",
    doStream: async () => ({
      stream: simulateReadableStream({
        chunks: [{ type: "stream-start", warnings: [] } as StreamPart, ...parts],
        initialDelayInMs: null,
        chunkDelayInMs: null,
      }),
    }),
  });
}

/**
 * REGRESSION (01eef80): v7 answers "Invalid prompt: System messages are not
 * allowed..." when a system message rides inside `messages`. Sessions do store
 * one, so the provider must lift it into `instructions`. Reverting that lift
 * makes this test throw rather than fail an assertion — either way, it fails.
 */
describe("real SDK prompt standardization", () => {
  it("accepts a session history whose first message is a system message", async () => {
    const model = mockModel(textParts("ok"));

    const step = await aiSdkProvider(model).step(
      [
        { role: "system", content: "you are a support assistant" },
        { role: "user", content: "show me all tickets" },
      ],
      {},
    );

    expect(step.text).toBe("ok");

    // The standardized prompt the model actually received: the system content
    // arrived through the system channel, exactly once, ahead of the user turn.
    const prompt = model.doStreamCalls[0]?.prompt;
    expect(prompt?.[0]).toEqual({ role: "system", content: "you are a support assistant" });
    expect(prompt?.filter((m) => m.role === "system")).toHaveLength(1);
    expect(prompt?.[1]?.role).toBe("user");
  });
});

describe("real SDK stream shaping", () => {
  it("emits one onTextDelta per delta and returns the concatenated text", async () => {
    const model = mockModel(textParts("hel", "lo", " there"));

    const deltas: string[] = [];
    const step = await aiSdkProvider(model).step([{ role: "user", content: "hi" }], {
      onTextDelta: (t) => deltas.push(t),
    });

    expect(deltas).toEqual(["hel", "lo", " there"]);
    expect(step.text).toBe("hello there");
    expect(step.toolCalls).toEqual([]);
  });

  it("preserves toolCallId, toolName and parsed args through the real shaping", async () => {
    const model = mockModel([toolCallPart("call-1", "search_tickets", { query: "password" }), FINISH]);

    const step = await aiSdkProvider(model).step([{ role: "user", content: "find it" }], {});

    expect(step.toolCalls).toEqual([
      { toolCallId: "call-1", toolName: "search_tickets", args: { query: "password" } },
    ]);
  });

  it("collects multiple tool calls from one step in order", async () => {
    const model = mockModel([
      toolCallPart("call-1", "search_tickets", { query: "billing" }),
      toolCallPart("call-2", "mutate_ticket", { id: "t-1", action: "update", fields: { status: "closed" } }),
      FINISH,
    ]);

    const step = await aiSdkProvider(model).step([{ role: "user", content: "close it" }], {});

    expect(step.toolCalls.map((c) => [c.toolCallId, c.toolName])).toEqual([
      ["call-1", "search_tickets"],
      ["call-2", "mutate_ticket"],
    ]);
    expect(step.toolCalls[1]?.args).toEqual({
      id: "t-1",
      action: "update",
      fields: { status: "closed" },
    });
  });

  it("surfaces an error part as a rejection instead of an empty successful step", async () => {
    const model = mockModel([{ type: "error", error: new Error("API key is missing") }, FINISH]);

    await expect(aiSdkProvider(model).step([{ role: "user", content: "hi" }], {})).rejects.toThrow(
      /model request failed: API key is missing/,
    );
  });
});

describe("real SDK tool declaration", () => {
  it("declares every tool to the model, with no execute handler for the SDK to run", async () => {
    const model = mockModel(textParts("ok"));

    await aiSdkProvider(model).step([{ role: "user", content: "hi" }], {});

    const call = model.doStreamCalls[0];
    expect(call?.tools?.map((t) => t.name).sort()).toEqual([
      "get_ticket",
      "mutate_ticket",
      "search_tickets",
    ]);
    expect(call?.toolChoice).toEqual({ type: "auto" });

    // The tool spec that crosses the provider boundary carries a schema and
    // nothing runnable — the SDK is never handed a way to execute a tool.
    for (const t of call?.tools ?? []) {
      expect(t.type).toBe("function");
      expect(Object.keys(t)).not.toContain("execute");
      expect((t as { inputSchema?: unknown }).inputSchema).toBeDefined();
    }
  });
});

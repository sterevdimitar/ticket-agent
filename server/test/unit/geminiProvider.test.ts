import { describe, expect, it, vi } from "vitest";

const fullStream = vi.hoisted(() => ({ parts: [] as unknown[] }));
const lastCall = vi.hoisted(() => ({ options: undefined as any }));

vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>();
  return {
    ...actual,
    streamText: (options: unknown) => {
      lastCall.options = options;
      return {
        fullStream: (async function* () {
          for (const p of fullStream.parts) yield p;
        })(),
      };
    },
  };
});

const { geminiProvider } = await import("../../src/agent/geminiProvider.js");

describe("geminiProvider", () => {
  it("streams text deltas and collects tool calls", async () => {
    fullStream.parts = [
      { type: "text-delta", text: "hel" },
      { type: "text-delta", text: "lo" },
      {
        type: "tool-call",
        toolCallId: "call-1",
        toolName: "search_tickets",
        input: { query: "password" },
      },
    ];

    const deltas: string[] = [];
    const step = await geminiProvider.step([], { onTextDelta: (t) => deltas.push(t) });

    expect(deltas).toEqual(["hel", "lo"]);
    expect(step.text).toBe("hello");
    expect(step.toolCalls).toEqual([
      { toolCallId: "call-1", toolName: "search_tickets", args: { query: "password" } },
    ]);
  });

  it("throws on an error part instead of returning an empty step", async () => {
    fullStream.parts = [{ type: "error", error: new Error("API key is missing") }];
    await expect(geminiProvider.step([], {})).rejects.toThrow(/API key is missing/);
  });

  it("forwards a tool call for a tool we do not expose — the loop decides and logs it", async () => {
    fullStream.parts = [
      { type: "tool-call", toolCallId: "call-1", toolName: "exfiltrate", input: {} },
    ];
    const step = await geminiProvider.step([], {});
    expect(step.toolCalls).toEqual([
      { toolCallId: "call-1", toolName: "exfiltrate", args: {} },
    ]);
  });
});

/**
 * v7 rejects system messages inside `messages` (allowSystemInMessages defaults to
 * false), answering "Invalid prompt: System messages are not allowed...". Our
 * sessions do store a system message, so the provider must lift it out.
 */
describe("geminiProvider system prompt handling", () => {
  it("sends the system message as `instructions`, not inside `messages`", async () => {
    fullStream.parts = [{ type: "text-delta", text: "ok" }];
    await geminiProvider.step(
      [
        { role: "system", content: "you are a support assistant" },
        { role: "user", content: "show me all tickets" },
      ],
      {},
    );

    expect(lastCall.options.instructions).toBe("you are a support assistant");
    expect(lastCall.options.messages).toEqual([
      { role: "user", content: "show me all tickets" },
    ]);
    expect(JSON.stringify(lastCall.options.messages)).not.toContain("system");
  });

  it("merges multiple system messages in order", async () => {
    fullStream.parts = [];
    await geminiProvider.step(
      [
        { role: "system", content: "first" },
        { role: "user", content: "hi" },
        { role: "system", content: "second" },
      ],
      {},
    );
    expect(lastCall.options.instructions).toBe("first\n\nsecond");
  });

  it("omits `instructions` entirely when there is no system message", async () => {
    fullStream.parts = [];
    await geminiProvider.step([{ role: "user", content: "hi" }], {});
    expect(lastCall.options.instructions).toBeUndefined();
    expect("instructions" in lastCall.options).toBe(false);
  });
});

/**
 * v7 types these stream parts as `any` at our call site, so the compiler cannot
 * catch a field rename. These assert the runtime guard fails loudly instead of
 * silently proposing a tool call with undefined arguments.
 */
describe("geminiProvider SDK shape drift", () => {
  it("throws when a tool-call part no longer carries `input`", async () => {
    fullStream.parts = [
      { type: "tool-call", toolCallId: "call-1", toolName: "search_tickets", args: { query: "x" } },
    ];
    await expect(geminiProvider.step([], {})).rejects.toThrow(/stream shape changed/);
  });

  it("throws when a tool-call part no longer carries `toolCallId`", async () => {
    fullStream.parts = [
      { type: "tool-call", id: "call-1", toolName: "search_tickets", input: {} },
    ];
    await expect(geminiProvider.step([], {})).rejects.toThrow(/stream shape changed/);
  });

  it("throws when a text-delta part no longer carries `text`", async () => {
    fullStream.parts = [{ type: "text-delta", delta: "hello" }];
    await expect(geminiProvider.step([], {})).rejects.toThrow(/stream shape changed/);
  });

  it("names the offending part and its keys so the failure is diagnosable", async () => {
    fullStream.parts = [{ type: "text-delta", delta: "hello" }];
    await expect(geminiProvider.step([], {})).rejects.toThrow(/'text-delta' part has keys \[type, delta\]/);
  });

  it("accepts a null input rather than treating it as a missing field", async () => {
    fullStream.parts = [
      { type: "tool-call", toolCallId: "call-1", toolName: "search_tickets", input: null },
    ];
    const step = await geminiProvider.step([], {});
    expect(step.toolCalls[0]?.args).toBeNull();
  });
});

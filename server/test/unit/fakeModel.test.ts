import { describe, expect, it } from "vitest";
import { scriptedProvider } from "../../src/agent/fakeModel.js";

describe("scriptedProvider", () => {
  it("plays scripted steps in order with deterministic tool call ids", async () => {
    const provider = scriptedProvider([
      { toolCall: { toolName: "search_tickets", args: { query: "password" } } },
      { text: "here you go" },
    ]);

    const first = await provider.step([], {});
    expect(first.toolCalls).toHaveLength(1);
    expect(first.toolCalls[0]).toMatchObject({
      toolCallId: "tc-1",
      toolName: "search_tickets",
      args: { query: "password" },
    });

    const second = await provider.step([], {});
    expect(second.text).toBe("here you go");
    expect(second.toolCalls).toHaveLength(0);
  });

  it("numbers tool call ids across steps", async () => {
    const provider = scriptedProvider([
      { toolCall: { toolName: "search_tickets", args: {} } },
      { toolCall: { toolName: "mutate_ticket", args: {} } },
    ]);
    await provider.step([], {});
    const second = await provider.step([], {});
    expect(second.toolCalls[0]?.toolCallId).toBe("tc-2");
  });

  it("emits scripted text through onTextDelta", async () => {
    const provider = scriptedProvider([{ text: "hello" }]);
    const deltas: string[] = [];
    await provider.step([], { onTextDelta: (t) => deltas.push(t) });
    expect(deltas).toEqual(["hello"]);
  });

  it("returns an empty step once the script is exhausted", async () => {
    const provider = scriptedProvider([{ text: "only" }]);
    await provider.step([], {});
    expect(await provider.step([], {})).toEqual({ text: "", toolCalls: [] });
  });

  it("can propose several tool calls in one step (hostile model)", async () => {
    const provider = scriptedProvider([
      {
        toolCalls: [
          { toolName: "mutate_ticket", args: { id: "TA-1", action: "delete" } },
          { toolName: "mutate_ticket", args: { id: "TA-2", action: "delete" } },
        ],
      },
    ]);
    const step = await provider.step([], {});
    expect(step.toolCalls.map((c) => c.toolCallId)).toEqual(["tc-1", "tc-2"]);
  });
});

import { beforeEach, describe, expect, it } from "vitest";
import { UNTRUSTED_CLOSE, UNTRUSTED_OPEN } from "../../src/agent/prompt.js";
import { getSession } from "../../src/store/sessionStore.js";
import type { Message } from "../../src/types.js";
import { playModel, postApproval, postChat, resetWorld } from "../helpers.js";

/**
 * The decided outcome must reach the model as a fact it can report, not as
 * untrusted ticket data. Wrapped, it read as "text written by customers or
 * attackers" and the model would not confirm a mutation it had just performed —
 * it fell back on the system prompt's only mutate fact and told an approving user
 * their change was still pending. These tests pin the envelope's absence on the
 * mutate path while `storedInjection` pins its presence on every read path.
 */
function mutateResults(sessionId: string): string[] {
  const session = getSession(sessionId);
  const out: string[] = [];
  for (const message of (session?.messages ?? []) as Message[]) {
    if (message.role !== "tool" || typeof message.content === "string") continue;
    for (const part of message.content) {
      if (part.type === "tool-result" && part.toolName === "mutate_ticket") {
        const output = part.output as { type: string; value: string };
        out.push(output.value);
      }
    }
  }
  return out;
}

async function openApproval(sessionId: string, ticketId = "TA-2"): Promise<string> {
  playModel([
    {
      toolCall: {
        toolName: "mutate_ticket",
        args: { id: ticketId, action: "update", fields: { status: "closed" } },
      },
    },
  ]);
  const res = await postChat("tenant-a", sessionId, `close ${ticketId}`);
  return res.frames.find((f) => f.type === "approval-required")!.data.approvalId;
}

describe("mutation outcomes reach the model as server facts", () => {
  beforeEach(resetWorld);

  it("does not spotlight an executed mutation as untrusted data", async () => {
    const approvalId = await openApproval("s1");
    playModel([{ text: "Closed TA-2." }]);
    await postApproval("tenant-a", "s1", approvalId, true);

    expect(mutateResults("s1")).toEqual(['{"status":"updated"}']);
  });

  it("does not spotlight a declined mutation either", async () => {
    const approvalId = await openApproval("s1");
    playModel([{ text: "Left it alone." }]);
    await postApproval("tenant-a", "s1", approvalId, false);

    expect(mutateResults("s1")).toEqual(['{"status":"declined_by_user"}']);
  });

  it("does not spotlight a mutate rejection raised before any human saw it", async () => {
    playModel([
      { toolCall: { toolName: "mutate_ticket", args: { id: "TB-1", action: "delete" } } },
      { text: "No such ticket here." },
    ]);
    await postChat("tenant-a", "s2", "delete TB-1");

    const results = mutateResults("s2");
    expect(results).toEqual(['{"error":"ticket_not_found"}']);
    expect(results[0]).not.toContain(UNTRUSTED_OPEN);
    expect(results[0]).not.toContain(UNTRUSTED_CLOSE);
  });

  it("still leaves the model able to resume and speak after the decision", async () => {
    const approvalId = await openApproval("s1");
    playModel([{ text: "Closed TA-2." }]);
    const res = await postApproval("tenant-a", "s1", approvalId, true);

    const text = res.frames
      .filter((f) => f.type === "text-delta")
      .map((f) => f.data.text)
      .join("");
    expect(text).toBe("Closed TA-2.");
  });
});

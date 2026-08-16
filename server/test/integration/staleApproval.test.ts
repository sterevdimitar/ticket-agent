import { beforeEach, describe, expect, it } from "vitest";
import { getApproval } from "../../src/approvals/registry.js";
import { applyUpdate, getTicket } from "../../src/store/ticketStore.js";
import { executedMutations, mutateLog, playModel, postApproval, postChat, resetWorld } from "../helpers.js";

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

async function openDeleteApproval(sessionId: string, ticketId = "TA-2"): Promise<string> {
  playModel([
    {
      toolCall: {
        toolName: "mutate_ticket",
        args: { id: ticketId, action: "delete" },
      },
    },
  ]);
  const res = await postChat("tenant-a", sessionId, `delete ${ticketId}`);
  return res.frames.find((f) => f.type === "approval-required")!.data.approvalId;
}

describe("stale-approval guard", () => {
  beforeEach(resetWorld);

  it("blocks an approved update when the ticket changed mid-decision", async () => {
    const approvalId = await openApproval("s1");

    // The window the staleness check exists for: between the proposal the human
    // saw and the write, another actor in the tenant changes the ticket.
    applyUpdate("TA-2", { description: "changed while deciding" });

    playModel([{ text: "That ticket changed, let me look again." }]);
    const res = await postApproval("tenant-a", "s1", approvalId, true);

    expect(res.status).toBe(200);
    expect(res.frames.find((f) => f.type === "tool-result")?.data.result).toEqual({
      error: "ticket_changed",
    });

    expect(getTicket("TA-2")?.status).toBe("open");
    expect(executedMutations()).toHaveLength(0);

    const blocked = mutateLog().filter((e) => e.outcome === "blocked_stale");
    expect(blocked).toHaveLength(1);
    expect(blocked[0]?.approvalId).toBe(approvalId);

    expect(getApproval(approvalId)?.status).toBe("CONSUMED");
  });

  it("still executes when the ticket did not change while deciding", async () => {
    const approvalId = await openApproval("s1");
    playModel([{ text: "Closed." }]);
    const res = await postApproval("tenant-a", "s1", approvalId, true);

    expect(res.status).toBe(200);
    expect(getTicket("TA-2")?.status).toBe("closed");
    expect(executedMutations()).toHaveLength(1);
    expect(mutateLog().some((e) => e.outcome === "blocked_stale")).toBe(false);
  });

  it("blocks an approved delete when the ticket changed mid-decision", async () => {
    const approvalId = await openDeleteApproval("s1");

    applyUpdate("TA-2", { description: "changed while deciding" });

    playModel([{ text: "That ticket changed, let me look again." }]);
    const res = await postApproval("tenant-a", "s1", approvalId, true);

    expect(res.status).toBe(200);
    expect(res.frames.find((f) => f.type === "tool-result")?.data.result).toEqual({
      error: "ticket_changed",
    });
    expect(getTicket("TA-2")).toBeDefined();
    expect(executedMutations()).toHaveLength(0);

    const blocked = mutateLog().filter((e) => e.outcome === "blocked_stale");
    expect(blocked).toHaveLength(1);
    expect(blocked[0]?.approvalId).toBe(approvalId);

    expect(getApproval(approvalId)?.status).toBe("CONSUMED");
  });
});

import { beforeEach, describe, expect, it } from "vitest";
import { getTicket } from "../../src/store/ticketStore.js";
import { executedMutations, mutateLog, playModel, postApproval, postChat, resetWorld } from "../helpers.js";

describe("cross-tenant mutation", () => {
  beforeEach(resetWorld);

  it("answers ticket_not_found and creates no approval", async () => {
    playModel([
      { toolCall: { toolName: "mutate_ticket", args: { id: "TB-2", action: "delete" } } },
      { text: "I could not find that ticket." },
    ]);

    const { frames } = await postChat("tenant-a", "s1", "delete the acquisition ticket");

    expect(frames.some((f) => f.type === "approval-required")).toBe(false);
    expect(frames.find((f) => f.type === "tool-result")?.data.result).toEqual({
      error: "ticket_not_found",
    });
    expect(mutateLog().some((e) => e.outcome === "blocked_not_found")).toBe(true);
    expect(executedMutations()).toHaveLength(0);
    expect(getTicket("TB-2")).toBeDefined();
  });

  it("is indistinguishable from a ticket that does not exist", async () => {
    playModel([
      { toolCall: { toolName: "mutate_ticket", args: { id: "TB-2", action: "delete" } } },
      { text: "no" },
    ]);
    const foreign = await postChat("tenant-a", "s1", "delete TB-2");

    playModel([
      { toolCall: { toolName: "mutate_ticket", args: { id: "DOES-NOT-EXIST", action: "delete" } } },
      { text: "no" },
    ]);
    const missing = await postChat("tenant-a", "s2", "delete DOES-NOT-EXIST");

    const resultOf = (r: typeof foreign) =>
      r.frames.find((f) => f.type === "tool-result")?.data.result;
    expect(resultOf(foreign)).toEqual(resultOf(missing));
  });

  it("rejects a fabricated approval id with 404", async () => {
    const res = await postApproval("tenant-a", "s1", "11111111-2222-3333-4444-555555555555", true);
    expect(res.status).toBe(404);
    expect(executedMutations()).toHaveLength(0);
  });

  it("blocks an update that tries to re-tenant a ticket", async () => {
    playModel([
      {
        toolCall: {
          toolName: "mutate_ticket",
          args: { id: "TA-1", action: "update", fields: { tenantId: "tenant-b" } },
        },
      },
      { text: "no" },
    ]);

    const { frames } = await postChat("tenant-a", "s1", "move TA-1 to tenant-b");

    expect(frames.some((f) => f.type === "approval-required")).toBe(false);
    expect(frames.find((f) => f.type === "tool-result")?.data.result).toEqual({
      error: "invalid_args",
    });
    expect(getTicket("TA-1")?.tenantId).toBe("tenant-a");
  });
});

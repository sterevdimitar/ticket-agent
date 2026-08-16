import { beforeEach, describe, expect, it } from "vitest";
import { getApproval, setNow } from "../../src/approvals/registry.js";
import { config } from "../../src/config.js";
import { getTicket, removeTicket } from "../../src/store/ticketStore.js";
import { resetSessions } from "../../src/store/sessionStore.js";
import {
  executedMutations,
  mutateLog,
  playModel,
  postApproval,
  postChat,
  resetWorld,
} from "../helpers.js";

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

describe("approval gate bypass attempts", () => {
  beforeEach(resetWorld);

  it("rejects a fabricated approval id (404, nothing runs)", async () => {
    await openApproval("s1");
    const res = await postApproval("tenant-a", "s1", "fabricated-id", true);
    expect(res.status).toBe(404);
    expect(executedMutations()).toHaveLength(0);
    expect(getTicket("TA-2")?.status).toBe("open");
  });

  it("rejects a real approval presented by another tenant with the same 404 (no oracle)", async () => {
    const approvalId = await openApproval("s1");
    const res = await postApproval("tenant-b", "s1", approvalId, true);
    expect(res.status).toBe(404);
    expect(executedMutations()).toHaveLength(0);
    expect(getApproval(approvalId)?.status).toBe("PENDING");
  });

  it("rejects a real approval presented under another session", async () => {
    const approvalId = await openApproval("s1");
    const res = await postApproval("tenant-a", "other-session", approvalId, true);
    expect(res.status).toBe(404);
    expect(executedMutations()).toHaveLength(0);
  });

  it("executes exactly once when the owner approves", async () => {
    const approvalId = await openApproval("s1");
    playModel([{ text: "Closed." }]);
    const res = await postApproval("tenant-a", "s1", approvalId, true);

    expect(res.status).toBe(200);
    expect(getTicket("TA-2")?.status).toBe("closed");
    expect(executedMutations()).toHaveLength(1);
  });

  it("rejects a replayed approval with 409 and does not execute twice", async () => {
    const approvalId = await openApproval("s1");
    playModel([{ text: "Closed." }]);
    await postApproval("tenant-a", "s1", approvalId, true);

    const replay = await postApproval("tenant-a", "s1", approvalId, true);
    expect(replay.status).toBe(409);
    expect(executedMutations()).toHaveLength(1);
  });

  it("rejects an approval that has expired", async () => {
    const approvalId = await openApproval("s1");
    setNow(() => Date.now() + config.approvalTtlMs + 1000);

    const res = await postApproval("tenant-a", "s1", approvalId, true);
    expect(res.status).toBe(409);
    expect(executedMutations()).toHaveLength(0);
    expect(getTicket("TA-2")?.status).toBe("open");
    expect(getApproval(approvalId)?.status).toBe("EXPIRED");
  });

  it("re-checks ownership after the approval is consumed (ticket vanished mid-decision)", async () => {
    const approvalId = await openApproval("s1");

    // The window the second ownership check exists for: between the proposal the
    // human saw and the write, the ticket stops being theirs (here, stops existing).
    removeTicket("TA-2");
    playModel([{ text: "That ticket is no longer there." }]);

    const res = await postApproval("tenant-a", "s1", approvalId, true);

    // The decision is spent and the turn resumes normally — the model is simply
    // told the write did not happen, rather than the request 500ing out of
    // applyUpdate with the session's tool call left dangling.
    expect(res.status).toBe(200);
    expect(res.frames.some((f) => f.type === "done")).toBe(true);
    expect(res.frames.find((f) => f.type === "tool-result")?.data.result).toEqual({
      error: "ticket_not_found",
    });

    expect(executedMutations()).toHaveLength(0);
    const blocked = mutateLog().filter((e) => e.outcome === "blocked_not_found");
    expect(blocked).toHaveLength(1);
    expect(blocked[0]?.approvalId).toBe(approvalId);
  });

  it("a stale replay is not_pending, not expired, and forges no expiry record", async () => {
    const approvalId = await openApproval("s1");
    playModel([{ text: "Closed." }]);
    await postApproval("tenant-a", "s1", approvalId, true);

    // The replay arrives after the TTL would have lapsed. Checking status before
    // expiry is what keeps this a spent decision rather than a lapsed one: calling
    // it "expired" would write an approval_expired entry — once per replay, in an
    // append-only log — for a mutation that actually ran.
    setNow(() => Date.now() + config.approvalTtlMs + 1000);
    const replay = await postApproval("tenant-a", "s1", approvalId, true);

    expect(replay.status).toBe(409);
    expect(JSON.parse(replay.body)).toEqual({ error: "not_pending" });
    expect(mutateLog().some((e) => e.outcome === "approval_expired")).toBe(false);
    expect(executedMutations()).toHaveLength(1);
    expect(getApproval(approvalId)?.status).toBe("CONSUMED");
  });

  it("logs blocked_session_lost when an approve's session vanished after the decision was consumed", async () => {
    const approvalId = await openApproval("s1");

    // In this in-memory build the session can only vanish this way (test reset or
    // process restart) — but the log's honesty is the invariant either way.
    resetSessions();
    const res = await postApproval("tenant-a", "s1", approvalId, true);

    expect(res.status).toBe(404);
    expect(getApproval(approvalId)?.status).toBe("CONSUMED");
    const lost = mutateLog().filter((e) => e.outcome === "blocked_session_lost");
    expect(lost).toHaveLength(1);
    expect(lost[0]?.approvalId).toBe(approvalId);
  });

  it("logs blocked_session_lost for a decline too, against the rejected record", async () => {
    const approvalId = await openApproval("s1");

    resetSessions();
    const res = await postApproval("tenant-a", "s1", approvalId, false);

    expect(res.status).toBe(404);
    expect(getApproval(approvalId)?.status).toBe("REJECTED");
    const lost = mutateLog().filter((e) => e.outcome === "blocked_session_lost");
    expect(lost).toHaveLength(1);
    expect(lost[0]?.approvalId).toBe(approvalId);
  });

  it("a decline from another tenant 404s and leaves the record decidable by its owner", async () => {
    const approvalId = await openApproval("s1");

    const foreign = await postApproval("tenant-b", "s1", approvalId, false);
    expect(foreign.status).toBe(404);
    expect(getApproval(approvalId)?.status).toBe("PENDING");

    // The foreign decline must not have burned the decision the owner still holds.
    playModel([{ text: "Closed." }]);
    const owner = await postApproval("tenant-a", "s1", approvalId, true);
    expect(owner.status).toBe(200);
    expect(getTicket("TA-2")?.status).toBe("closed");
    expect(executedMutations()).toHaveLength(1);
  });

  it("cannot be re-approved after a decline", async () => {
    const approvalId = await openApproval("s1");
    playModel([{ text: "ok" }]);
    await postApproval("tenant-a", "s1", approvalId, false);

    const res = await postApproval("tenant-a", "s1", approvalId, true);
    expect(res.status).toBe(409);
    expect(executedMutations()).toHaveLength(0);
    expect(getTicket("TA-2")?.status).toBe("open");
  });

  it("executes the frozen args, not anything the approve request supplies", async () => {
    const approvalId = await openApproval("s1");
    playModel([{ text: "ok" }]);

    // The client tries to smuggle a delete of a different ticket into the decision.
    const res = await app_postWithExtras(approvalId, {
      sessionId: "s1",
      approved: true,
      id: "TA-1",
      action: "delete",
      fields: { status: "closed" },
    });

    expect(res.status).toBe(200);
    expect(getTicket("TA-1")).toBeDefined();
    expect(getTicket("TA-2")?.status).toBe("closed");
    expect(executedMutations()).toHaveLength(1);
    expect(executedMutations()[0]?.args).toMatchObject({ id: "TA-2", action: "update" });
  });
});

async function app_postWithExtras(approvalId: string, body: unknown) {
  const { app } = await import("../../src/index.js");
  return app.request(`/approvals/${approvalId}`, {
    method: "POST",
    headers: { "content-type": "application/json", "X-Tenant-ID": "tenant-a" },
    body: JSON.stringify(body),
  });
}

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  consumeApproval,
  createApproval,
  getApproval,
  rejectApproval,
  resetApprovals,
  setNow,
  sweepApprovals,
} from "../../src/approvals/registry.js";
import type { MutateArgs, ServerView } from "../../src/types.js";

const frozenArgs: MutateArgs = { id: "TA-2", action: "update", fields: { status: "closed" } };
const serverView: ServerView = {
  title: "Password reset fails on mobile",
  currentStatus: "open",
  diff: "status: open → closed",
  danger: false,
};

function create(overrides: Partial<Parameters<typeof createApproval>[0]> = {}) {
  return createApproval({
    tenantId: "tenant-a",
    sessionId: "s1",
    toolCallId: "tc-1",
    frozenArgs,
    frozenUpdatedAt: "2026-01-01T00:00:00.000Z",
    serverView,
    ...overrides,
  });
}

const ctx = { tenantId: "tenant-a", sessionId: "s1" };

describe("approval registry", () => {
  beforeEach(() => {
    resetApprovals();
  });
  afterEach(() => {
    setNow(Date.now);
  });

  it("creates a PENDING record with a future expiry", () => {
    const record = create();
    const found = getApproval(record.approvalId);
    expect(found?.status).toBe("PENDING");
    expect(Date.parse(found!.expiresAt)).toBeGreaterThan(Date.now());
    expect(found?.frozenArgs).toEqual(frozenArgs);
  });

  it("consumes once and marks the record CONSUMED", () => {
    const record = create();
    const result = consumeApproval(record.approvalId, ctx);
    expect(result.ok).toBe(true);
    expect(getApproval(record.approvalId)?.status).toBe("CONSUMED");
  });

  it("refuses a replayed consume", () => {
    const record = create();
    consumeApproval(record.approvalId, ctx);
    expect(consumeApproval(record.approvalId, ctx)).toEqual({
      ok: false,
      reason: "not_pending",
    });
  });

  it("refuses a consume from another tenant", () => {
    const record = create();
    expect(consumeApproval(record.approvalId, { tenantId: "tenant-b", sessionId: "s1" })).toEqual({
      ok: false,
      reason: "forbidden",
    });
    expect(getApproval(record.approvalId)?.status).toBe("PENDING");
  });

  it("refuses a consume from another session", () => {
    const record = create();
    expect(consumeApproval(record.approvalId, { tenantId: "tenant-a", sessionId: "s2" })).toEqual({
      ok: false,
      reason: "forbidden",
    });
  });

  it("reports not_found for an unknown id", () => {
    expect(consumeApproval("nope", ctx)).toEqual({ ok: false, reason: "not_found" });
  });

  it("refuses an expired approval and marks it EXPIRED", () => {
    const record = create();
    const past = Date.now();
    setNow(() => past + 10 * 60_000);
    expect(consumeApproval(record.approvalId, ctx)).toEqual({ ok: false, reason: "expired" });
    expect(getApproval(record.approvalId)?.status).toBe("EXPIRED");
  });

  it("rejects a pending approval, after which consume fails", () => {
    const record = create();
    const rejected = rejectApproval(record.approvalId, ctx);
    expect(rejected.ok).toBe(true);
    expect(getApproval(record.approvalId)?.status).toBe("REJECTED");
    expect(consumeApproval(record.approvalId, ctx)).toEqual({ ok: false, reason: "not_pending" });
  });

  it("refuses a reject from another tenant", () => {
    const record = create();
    expect(rejectApproval(record.approvalId, { tenantId: "tenant-b", sessionId: "s1" })).toEqual({
      ok: false,
      reason: "forbidden",
    });
  });

  it("issues distinct ids for distinct approvals", () => {
    expect(create().approvalId).not.toBe(create().approvalId);
  });

  it("only one of many concurrent consumes of the same id succeeds", async () => {
    const record = create();
    const results = await Promise.all(
      Array.from({ length: 5 }, async () => consumeApproval(record.approvalId, ctx)),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(1);
  });

  describe("sweepApprovals", () => {
    it("flips only lapsed PENDING records to EXPIRED and returns them", () => {
      const lapsed = create();
      const consumed = create();
      consumeApproval(consumed.approvalId, ctx);
      const rejected = create();
      rejectApproval(rejected.approvalId, ctx);

      const past = Date.now();
      setNow(() => past + 10 * 60_000);
      // Created after the clock advanced, so its own TTL window is still ahead of
      // the swept instant — a genuinely-still-pending record.
      const stillPending = create({ toolCallId: "tc-fresh" });

      const swept = sweepApprovals();

      expect(swept.map((r) => r.approvalId)).toEqual([lapsed.approvalId]);
      expect(getApproval(lapsed.approvalId)?.status).toBe("EXPIRED");
      expect(getApproval(consumed.approvalId)?.status).toBe("CONSUMED");
      expect(getApproval(rejected.approvalId)?.status).toBe("REJECTED");
      expect(getApproval(stillPending.approvalId)?.status).toBe("PENDING");
    });

    it("returns nothing on a second sweep", () => {
      create();
      const past = Date.now();
      setNow(() => past + 10 * 60_000);
      expect(sweepApprovals()).toHaveLength(1);
      expect(sweepApprovals()).toEqual([]);
    });
  });
});

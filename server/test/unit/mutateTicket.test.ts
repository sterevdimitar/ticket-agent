import { beforeEach, describe, expect, it } from "vitest";
import { getTicket, resetTickets } from "../../src/store/ticketStore.js";
import {
  authorize,
  buildServerView,
  executeMutation,
  validateMutate,
} from "../../src/tools/mutateTicket.js";
import type { MutateArgs, Ticket } from "../../src/types.js";

describe("validateMutate", () => {
  it("accepts an update with allowlisted fields", () => {
    const r = validateMutate({ id: "TA-1", action: "update", fields: { status: "closed" } });
    expect(r).toEqual({ ok: true, args: { id: "TA-1", action: "update", fields: { status: "closed" } } });
  });

  it("accepts a delete with no fields", () => {
    const r = validateMutate({ id: "TA-1", action: "delete" });
    expect(r.ok).toBe(true);
  });

  it("rejects mass-assignment of tenantId", () => {
    expect(validateMutate({ id: "TA-1", action: "update", fields: { tenantId: "tenant-b" } })).toEqual(
      { ok: false, error: "invalid_args" },
    );
  });

  it("rejects mass-assignment of id", () => {
    expect(validateMutate({ id: "TA-1", action: "update", fields: { id: "TB-2" } })).toEqual({
      ok: false,
      error: "invalid_args",
    });
  });

  it("rejects an action outside the enum", () => {
    expect(validateMutate({ id: "TA-1", action: "purge" })).toEqual({
      ok: false,
      error: "invalid_args",
    });
  });

  it("rejects a status outside the enum", () => {
    expect(validateMutate({ id: "TA-1", action: "update", fields: { status: "deleted" } })).toEqual({
      ok: false,
      error: "invalid_args",
    });
  });

  it("rejects a non-object payload", () => {
    expect(validateMutate("delete everything")).toEqual({ ok: false, error: "invalid_args" });
  });

  it("rejects an unknown key smuggled in at the TOP level, not just inside fields", () => {
    // Stripping it instead would leave an ordinary-looking update in the audit
    // log, so the probe would never be visible to anyone reading it.
    expect(
      validateMutate({
        id: "TA-1",
        action: "update",
        tenantId: "tenant-b",
        fields: { status: "closed" },
      }),
    ).toEqual({ ok: false, error: "invalid_args" });
  });
});

describe("authorize", () => {
  beforeEach(() => {
    resetTickets();
  });

  it("accepts a ticket owned by the calling tenant", () => {
    const r = authorize("tenant-a", "TA-1");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.ticket.id).toBe("TA-1");
  });

  it("answers ticket_not_found for another tenant's ticket", () => {
    expect(authorize("tenant-a", "TB-2")).toEqual({ ok: false, error: "ticket_not_found" });
  });

  it("answers the same ticket_not_found for an id that does not exist", () => {
    expect(authorize("tenant-a", "NOPE")).toEqual({ ok: false, error: "ticket_not_found" });
  });
});

describe("buildServerView", () => {
  let ticket: Ticket;
  beforeEach(() => {
    resetTickets();
    ticket = getTicket("TA-2")!;
  });

  it("marks delete as dangerous with no diff", () => {
    const view = buildServerView(ticket, { id: "TA-2", action: "delete" });
    expect(view).toMatchObject({ danger: true, diff: null, currentStatus: "open" });
    expect(view.title).toBe(ticket.title);
  });

  it("lists only the fields that actually change", () => {
    const view = buildServerView(ticket, {
      id: "TA-2",
      action: "update",
      fields: { status: "closed", title: ticket.title },
    });
    expect(view.danger).toBe(false);
    expect(view.diff).toBe('status: "open" → "closed"');
  });

  it("cannot be made to forge a second diff line out of a field value", () => {
    // Interpolated raw, this description writes a line pixel-identical to one
    // buildServerView produces, and the human approves a status change that is
    // not in the payload at all.
    const view = buildServerView(ticket, {
      id: "TA-2",
      action: "update",
      fields: { description: "note\nstatus: open → closed" },
    });

    const diff = view.diff!;
    expect(diff.split("\n")).toHaveLength(1);
    expect(diff).not.toContain("\n");
    // The newline survives as a visible two-character escape inside quotes, so
    // the forged text reads as the value it is.
    expect(diff).toContain(String.raw`"note\nstatus: open → closed"`);
    expect(diff.startsWith("description: ")).toBe(true);
  });

  it("truncates an oversized field value with a marker rather than burying the diff", () => {
    const long = "x".repeat(500);
    const view = buildServerView(ticket, {
      id: "TA-2",
      action: "update",
      fields: { title: long },
    });

    const diff = view.diff!;
    expect(diff).toContain(`"${"x".repeat(120)}…"`);
    expect(diff).not.toContain("x".repeat(121));
    expect(diff.split("\n")).toHaveLength(1);
  });

  it("reports no change when the update is a no-op", () => {
    const view = buildServerView(ticket, {
      id: "TA-2",
      action: "update",
      fields: { title: ticket.title },
    });
    expect(view.diff).toBe("(no change)");
  });
});

describe("executeMutation", () => {
  beforeEach(() => {
    resetTickets();
  });

  it("merges only allowlisted fields and bumps updatedAt", () => {
    const before = { ...getTicket("TA-2")! };
    const originalDescription = before.description;
    // getTicket hands back the live row, so the timestamp has to be copied out
    // before the write or the comparison is against the post-write value.
    const beforeUpdatedAt = before.updatedAt;
    const args: MutateArgs = { id: "TA-2", action: "update", fields: { status: "closed" } };
    expect(executeMutation(args)).toEqual({ status: "updated" });
    const after = getTicket("TA-2")!;
    expect(after.status).toBe("closed");
    expect(after.description).toBe(originalDescription);
    expect(after.tenantId).toBe("tenant-a");
    // Against the seed's own createdAt an un-bumped updatedAt passes too, so
    // compare with the value read immediately before the write, strictly.
    expect(Date.parse(after.updatedAt)).toBeGreaterThan(Date.parse(beforeUpdatedAt));
    expect(after.createdAt).toBe(before.createdAt);
  });

  it("deletes the ticket", () => {
    expect(executeMutation({ id: "TA-1", action: "delete" })).toEqual({ status: "deleted" });
    expect(getTicket("TA-1")).toBeUndefined();
  });
});

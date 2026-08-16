import { beforeEach, describe, expect, it } from "vitest";
import { all, append, reset } from "../../src/log/invocationLog.js";
import type { InvocationLogEntry } from "../../src/types.js";

function entry(overrides: Partial<InvocationLogEntry> = {}): InvocationLogEntry {
  return {
    ts: "2026-08-01T09:00:00.000Z",
    tenantId: "tenant-a",
    sessionId: "s1",
    tool: "search_tickets",
    args: { query: "x" },
    outcome: "executed",
    ...overrides,
  };
}

describe("invocationLog", () => {
  beforeEach(() => {
    reset();
  });

  it("appends entries and returns them in order", () => {
    append(entry({ args: { query: "one" } }));
    append(entry({ tool: "mutate_ticket", outcome: "blocked_not_found" }));
    const entries = all();
    expect(entries).toHaveLength(2);
    expect(entries[0]?.args).toEqual({ query: "one" });
    expect(entries[1]?.outcome).toBe("blocked_not_found");
  });

  it("reset empties the log", () => {
    append(entry());
    reset();
    expect(all()).toHaveLength(0);
  });

  it("is append-only: callers cannot mutate the log through all()", () => {
    const original = entry();
    append(original);
    const snapshot = all() as InvocationLogEntry[];
    // Left in place: if all() handed back the live array, the log would now hold
    // two entries and this test would fail.
    snapshot.push(entry({ outcome: "declined_by_user" }));
    snapshot.push(entry({ outcome: "blocked_not_found" }));

    // Array-level isolation only. all() is a shallow copy, so the entry OBJECTS
    // are shared with the log by design today — this pins the boundary that
    // actually exists, not a deep freeze that does not.
    const after = all();
    expect(after).toHaveLength(1);
    expect(after[0]).toEqual(original);
  });
});

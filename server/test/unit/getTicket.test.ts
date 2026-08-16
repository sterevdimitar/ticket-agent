import { beforeEach, describe, expect, it } from "vitest";
import { config } from "../../src/config.js";
import { all, reset as resetLog } from "../../src/log/invocationLog.js";
import { resetTickets } from "../../src/store/ticketStore.js";
import { runGetTicket } from "../../src/tools/getTicket.js";
import { getTicketArgs } from "../../src/tools/schemas.js";

const LONG = "y".repeat(config.snippetMax + 800);

describe("runGetTicket", () => {
  beforeEach(() => {
    resetTickets();
    resetLog();
  });

  it("returns the full description, past the search snippet cap", () => {
    resetTickets([
      {
        id: "TA-9",
        tenantId: "tenant-a",
        title: "Long",
        status: "open",
        description: LONG,
        createdAt: "2026-08-01T09:00:00.000Z",
        updatedAt: "2026-08-01T09:00:00.000Z",
      },
    ]);
    const result = runGetTicket("tenant-a", { id: "TA-9" }, { sessionId: "s1" });
    expect(result).toMatchObject({ id: "TA-9", title: "Long", status: "open" });
    expect("description" in result && result.description).toBe(LONG);
    expect("description" in result && result.description.length).toBeGreaterThan(config.snippetMax);
  });

  it("answers a cross-tenant id exactly as it answers an unknown one", () => {
    // Probing ids must teach an attacker nothing about what exists elsewhere.
    const crossTenant = runGetTicket("tenant-a", { id: "TB-2" }, { sessionId: "s1" });
    const nonexistent = runGetTicket("tenant-a", { id: "TA-999" }, { sessionId: "s1" });
    expect(crossTenant).toEqual({ error: "ticket_not_found" });
    expect(crossTenant).toEqual(nonexistent);
  });

  it("never returns another tenant's description", () => {
    const result = runGetTicket("tenant-a", { id: "TB-2" }, { sessionId: "s1" });
    expect(JSON.stringify(result)).not.toContain("acquisition");
    expect(JSON.stringify(result)).not.toContain("valuation");
  });

  it("records an executed entry in the invocation log", () => {
    runGetTicket("tenant-a", { id: "TA-1" }, { sessionId: "s1" });
    expect(all()).toHaveLength(1);
    expect(all()[0]).toMatchObject({
      tool: "get_ticket",
      outcome: "executed",
      tenantId: "tenant-a",
      sessionId: "s1",
    });
  });

  it("logs a blocked_not_found for a cross-tenant probe", () => {
    // The probe must stay visible in the audit trail even though the caller is
    // told only "not found".
    runGetTicket("tenant-a", { id: "TB-2" }, { sessionId: "s1" });
    expect(all()[0]).toMatchObject({
      tool: "get_ticket",
      outcome: "blocked_not_found",
      tenantId: "tenant-a",
    });
  });
});

describe("getTicketArgs", () => {
  it("rejects a smuggled tenantId rather than silently stripping it", () => {
    // Same reason as searchArgs/mutateArgs: a strip would leave the sanitized
    // args in the log looking like an ordinary read.
    expect(getTicketArgs.safeParse({ id: "TA-1", tenantId: "tenant-b" }).success).toBe(false);
    expect(getTicketArgs.safeParse({ id: "TA-1" }).success).toBe(true);
  });
});

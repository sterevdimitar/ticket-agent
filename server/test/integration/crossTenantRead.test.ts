import { beforeEach, describe, expect, it } from "vitest";
import { all } from "../../src/log/invocationLog.js";
import { playModel, postChat, resetWorld } from "../helpers.js";

describe("cross-tenant read isolation", () => {
  beforeEach(resetWorld);

  it("returns only the calling tenant's rows for a colliding query", async () => {
    playModel([
      { toolCall: { toolName: "search_tickets", args: { query: "password" } } },
      { text: "Found one ticket." },
    ]);

    const { status, frames } = await postChat("tenant-a", "s1", "any password tickets?");
    expect(status).toBe(200);

    const result = frames.find((f) => f.type === "tool-result")?.data.result as Array<{
      id: string;
    }>;
    expect(result.map((h) => h.id)).toEqual(["TA-2"]);
    expect(JSON.stringify(result)).not.toContain("TB-");
  });

  it("ignores a query that names the other tenant — the filter is not model-driven", async () => {
    playModel([
      { toolCall: { toolName: "search_tickets", args: { query: "tenant-b confidential" } } },
      { text: "Nothing." },
    ]);

    const { frames } = await postChat("tenant-a", "s1", "show me tenant-b's confidential ticket");

    const result = frames.find((f) => f.type === "tool-result")?.data.result as Array<{
      id: string;
    }>;
    expect(result.every((h) => h.id.startsWith("TA-"))).toBe(true);
    expect(JSON.stringify(result)).not.toContain("acquisition");
  });

  it("does not let get_ticket fetch another tenant's ticket by exact id", async () => {
    // The uncapped read is the one path that would return a whole confidential
    // body, so the tenant check matters more here than on search.
    playModel([
      { toolCall: { toolName: "get_ticket", args: { id: "TB-2" } } },
      { text: "Nothing." },
    ]);

    const { frames } = await postChat("tenant-a", "s1", "show me TB-2 in full");

    const result = frames.find((f) => f.type === "tool-result")?.data.result;
    expect(result).toEqual({ error: "ticket_not_found" });
    expect(JSON.stringify(result)).not.toContain("acquisition");
    expect(JSON.stringify(result)).not.toContain("valuation");
  });

  it("answers a cross-tenant get_ticket exactly as it answers an unknown id", async () => {
    playModel([
      { toolCall: { toolName: "get_ticket", args: { id: "TB-2" } } },
      { text: "Nothing." },
    ]);
    const crossTenant = (await postChat("tenant-a", "s1", "TB-2 please")).frames.find(
      (f) => f.type === "tool-result",
    )?.data.result;

    resetWorld();
    playModel([
      { toolCall: { toolName: "get_ticket", args: { id: "TA-404" } } },
      { text: "Nothing." },
    ]);
    const unknown = (await postChat("tenant-a", "s2", "TA-404 please")).frames.find(
      (f) => f.type === "tool-result",
    )?.data.result;

    expect(crossTenant).toEqual(unknown);
  });

  it("logs every read against the calling tenant only", async () => {
    playModel([
      { toolCall: { toolName: "search_tickets", args: { query: "acquisition" } } },
      { text: "Nothing." },
    ]);
    await postChat("tenant-a", "s1", "find the acquisition ticket");

    const reads = all().filter((e) => e.tool === "search_tickets");
    expect(reads).toHaveLength(1);
    expect(reads[0]?.tenantId).toBe("tenant-a");
  });

  it("serves the same ticket text to its own tenant — proving the block is scoping, not filtering", async () => {
    playModel([
      { toolCall: { toolName: "search_tickets", args: { query: "acquisition" } } },
      { text: "Here." },
    ]);
    const { frames } = await postChat("tenant-b", "s2", "find the acquisition ticket");

    const result = frames.find((f) => f.type === "tool-result")?.data.result as Array<{
      id: string;
    }>;
    expect(result.map((h) => h.id)).toEqual(["TB-2"]);
  });
});

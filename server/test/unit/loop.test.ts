import { beforeEach, describe, expect, it } from "vitest";
import { scriptedProvider } from "../../src/agent/fakeModel.js";
import { runTurn } from "../../src/agent/loop.js";
import type { LoopEvents } from "../../src/agent/loop.js";
import type { ToolCallProposal } from "../../src/agent/provider.js";
import { getApproval, resetApprovals } from "../../src/approvals/registry.js";
import { config } from "../../src/config.js";
import { all, reset as resetLog } from "../../src/log/invocationLog.js";
import { getOrCreateSession, resetSessions } from "../../src/store/sessionStore.js";
import { getTicket, resetTickets } from "../../src/store/ticketStore.js";
import type { ApprovalRecord, Session } from "../../src/types.js";

type Captured = {
  events: LoopEvents;
  toolCalls: ToolCallProposal[];
  toolResults: Array<{ toolCallId: string; result: unknown }>;
  approvals: ApprovalRecord[];
  text: string[];
  done: number;
};

function capture(): Captured {
  const c: Partial<Captured> = {
    toolCalls: [],
    toolResults: [],
    approvals: [],
    text: [],
    done: 0,
  };
  c.events = {
    onTextDelta: (t) => c.text!.push(t),
    onToolCall: (call) => c.toolCalls!.push(call),
    onToolResult: (toolCallId, result) => c.toolResults!.push({ toolCallId, result }),
    onApprovalRequired: (record) => c.approvals!.push(record),
    onDone: () => {
      c.done!++;
    },
  };
  return c as Captured;
}

function session(tenantId = "tenant-a"): Session {
  const r = getOrCreateSession("s1", tenantId);
  if (!r.ok) throw new Error("session setup failed");
  r.session.messages.push({ role: "user", content: "do the thing" });
  return r.session;
}

beforeEach(() => {
  resetTickets();
  resetSessions();
  resetApprovals();
  resetLog();
});

describe("runTurn — get_ticket", () => {
  it("honors a get_ticket call and feeds the full description back", async () => {
    const long = "z".repeat(config.snippetMax + 300);
    resetTickets([
      {
        id: "TA-9",
        tenantId: "tenant-a",
        title: "Long",
        status: "open",
        description: long,
        createdAt: "2026-08-01T09:00:00.000Z",
        updatedAt: "2026-08-01T09:00:00.000Z",
      },
    ]);
    const c = capture();
    const provider = scriptedProvider([
      { toolCall: { toolName: "get_ticket", args: { id: "TA-9" } } },
      { text: "here is the whole thing" },
    ]);

    await runTurn(session(), "tenant-a", { provider, events: c.events });

    expect(c.toolResults).toHaveLength(1);
    expect(c.toolResults[0]?.result).toMatchObject({ id: "TA-9", description: long });
    expect(c.approvals).toHaveLength(0);
    expect(all().filter((e) => e.tool === "get_ticket" && e.outcome === "executed")).toHaveLength(1);
  });

  it("is not mistaken for an unknown tool", async () => {
    // The known-name guard must list get_ticket, or every call is answered
    // `unknown_tool` and logged as a hallucination.
    const c = capture();
    const provider = scriptedProvider([
      { toolCall: { toolName: "get_ticket", args: { id: "TA-1" } } },
      { text: "done" },
    ]);

    await runTurn(session(), "tenant-a", { provider, events: c.events });

    expect(all().some((e) => e.outcome === "blocked_unknown_tool")).toBe(false);
    expect(c.toolResults[0]?.result).not.toMatchObject({ error: "unknown_tool" });
  });

  it("cannot read across tenants through the loop", async () => {
    const c = capture();
    const provider = scriptedProvider([
      { toolCall: { toolName: "get_ticket", args: { id: "TB-2" } } },
      { text: "done" },
    ]);

    await runTurn(session(), "tenant-a", { provider, events: c.events });

    expect(c.toolResults[0]?.result).toEqual({ error: "ticket_not_found" });
    expect(JSON.stringify(c.toolResults)).not.toContain("acquisition");
  });

  it("rejects args carrying a smuggled tenantId", async () => {
    const c = capture();
    const provider = scriptedProvider([
      { toolCall: { toolName: "get_ticket", args: { id: "TA-1", tenantId: "tenant-b" } } },
      { text: "done" },
    ]);

    await runTurn(session(), "tenant-a", { provider, events: c.events });

    expect(c.toolResults[0]?.result).toEqual({ error: "invalid_args" });
    expect(
      all().filter((e) => e.tool === "get_ticket" && e.outcome === "blocked_invalid_args"),
    ).toHaveLength(1);
  });

  it("never creates an approval — it is a read", async () => {
    const c = capture();
    const provider = scriptedProvider([
      { toolCall: { toolName: "get_ticket", args: { id: "TA-1" } } },
      { text: "done" },
    ]);

    await runTurn(session(), "tenant-a", { provider, events: c.events });

    expect(c.approvals).toHaveLength(0);
    expect(c.done).toBe(1);
  });
});

describe("runTurn — reads", () => {
  it("runs a search, feeds the result back, and finishes", async () => {
    const c = capture();
    const provider = scriptedProvider([
      { toolCall: { toolName: "search_tickets", args: { query: "password" } } },
      { text: "here you go" },
    ]);

    await runTurn(session(), "tenant-a", { provider, events: c.events });

    expect(c.toolCalls).toHaveLength(1);
    expect(c.toolResults).toHaveLength(1);
    expect(c.approvals).toHaveLength(0);
    expect(c.done).toBe(1);
    expect(all().filter((e) => e.tool === "search_tickets" && e.outcome === "executed")).toHaveLength(1);
  });

  it("wraps tool output as untrusted data in the model history", async () => {
    const s = session();
    const provider = scriptedProvider([
      { toolCall: { toolName: "search_tickets", args: { query: "password" } } },
      { text: "done" },
    ]);
    await runTurn(s, "tenant-a", { provider, events: capture().events });
    const serialized = JSON.stringify(s.messages);
    expect(serialized).toContain("TICKET_DATA");
  });

  it("rejects malformed search args without touching the store", async () => {
    const c = capture();
    const provider = scriptedProvider([
      { toolCall: { toolName: "search_tickets", args: { query: 42 } } },
      { text: "ok" },
    ]);
    await runTurn(session(), "tenant-a", { provider, events: c.events });
    expect(c.toolResults[0]?.result).toEqual({ error: "invalid_args" });
    expect(all().filter((e) => e.outcome === "executed")).toHaveLength(0);
  });
});

describe("runTurn — one tool call per step", () => {
  it("honors only the first proposed call and persists only that one", async () => {
    const c = capture();
    const provider = scriptedProvider([
      {
        toolCalls: [
          { toolName: "search_tickets", args: { query: "password" } },
          { toolName: "search_tickets", args: { query: "login" } },
        ],
      },
      { text: "done" },
    ]);
    const s = session();
    await runTurn(s, "tenant-a", { provider, events: c.events });

    expect(c.toolCalls).toHaveLength(1);
    expect(c.toolCalls[0]?.toolCallId).toBe("tc-1");
    expect(JSON.stringify(s.messages)).not.toContain("tc-2");
  });

  it("records the dropped proposals in the audit log", async () => {
    const c = capture();
    const provider = scriptedProvider([
      {
        toolCalls: [
          { toolName: "mutate_ticket", args: { id: "TA-1", action: "delete" } },
          { toolName: "mutate_ticket", args: { id: "TA-2", action: "delete" } },
          { toolName: "search_tickets", args: { query: "password" } },
        ],
      },
    ]);

    await runTurn(session(), "tenant-a", { provider, events: c.events });

    const dropped = all().filter((e) => e.outcome === "dropped_parallel_call");
    expect(dropped).toHaveLength(2);
    expect(dropped.map((e) => e.tool)).toEqual(["mutate_ticket", "search_tickets"]);
    expect(dropped[0]?.args).toEqual({ id: "TA-2", action: "delete" });
    expect(dropped.every((e) => e.tenantId === "tenant-a" && e.sessionId === "s1")).toBe(true);
  });

  it("does not log a dropped call when the model proposes only one", async () => {
    const c = capture();
    const provider = scriptedProvider([
      { toolCall: { toolName: "search_tickets", args: { query: "password" } } },
      { text: "done" },
    ]);
    await runTurn(session(), "tenant-a", { provider, events: c.events });
    expect(all().some((e) => e.outcome === "dropped_parallel_call")).toBe(false);
  });

  it("logs dropped proposals without executing or gating them", async () => {
    const c = capture();
    const provider = scriptedProvider([
      {
        toolCalls: [
          { toolName: "search_tickets", args: { query: "password" } },
          { toolName: "mutate_ticket", args: { id: "TA-1", action: "delete" } },
        ],
      },
      { text: "done" },
    ]);

    await runTurn(session(), "tenant-a", { provider, events: c.events });

    // The dropped delete must leave no approval and no execution — only a record.
    expect(c.approvals).toHaveLength(0);
    expect(getTicket("TA-1")).toBeDefined();
    expect(all().filter((e) => e.tool === "mutate_ticket" && e.outcome === "executed")).toHaveLength(0);
    expect(all().filter((e) => e.outcome === "dropped_parallel_call")).toHaveLength(1);
  });
});

describe("runTurn — hallucinated tool names", () => {
  it("logs an unknown tool name, answers the call, and lets the turn continue", async () => {
    const c = capture();
    const provider = scriptedProvider([
      { toolCall: { toolName: "delete_all_tickets", args: { id: "TA-1" } } },
      { text: "done" },
    ]);
    const s = session();

    await runTurn(s, "tenant-a", { provider, events: c.events });

    const blocked = all().filter((e) => e.outcome === "blocked_unknown_tool");
    expect(blocked).toHaveLength(1);
    expect(blocked[0]).toMatchObject({
      tool: "delete_all_tickets",
      tenantId: "tenant-a",
      sessionId: "s1",
    });
    expect(blocked[0]?.args).toEqual({ id: "TA-1" });

    expect(c.toolResults).toHaveLength(1);
    expect(c.toolResults[0]?.result).toEqual({ error: "unknown_tool" });
    expect(c.toolResults[0]?.toolCallId).toBe(c.toolCalls[0]?.toolCallId);

    // The assistant's tool-call message already embeds the toolCallId, so
    // asserting on the whole-history JSON would pass even if the tool result
    // that answers the call were never pushed. Pin the tool RESULT message
    // specifically, so this test can only pass if that push actually happened.
    const toolMsgs = s.messages.filter((m) => m.role === "tool");
    expect(toolMsgs).toHaveLength(1);
    expect(JSON.stringify(toolMsgs[0])).toContain(c.toolCalls[0]!.toolCallId);
    expect(JSON.stringify(toolMsgs[0])).toContain("unknown_tool");

    // Never routed into the approval gate under the wrong name.
    expect(c.approvals).toHaveLength(0);

    expect(c.done).toBe(1);
    expect(c.text).toContain("done");
  });

  it("never lets mutate-shaped args under a hallucinated name reach the approval gate", async () => {
    const c = capture();
    const provider = scriptedProvider([
      { toolCall: { toolName: "delete_all_tickets", args: { id: "TA-1", action: "delete" } } },
      { text: "done" },
    ]);

    await runTurn(session(), "tenant-a", { provider, events: c.events });

    expect(c.approvals).toHaveLength(0);
    expect(getTicket("TA-1")).toBeDefined();
    expect(all().some((e) => e.outcome === "blocked_unknown_tool")).toBe(true);
    expect(all().some((e) => e.tool === "mutate_ticket")).toBe(false);
  });
});

describe("runTurn — mutations pause for approval", () => {
  it("creates a pending approval and stops without executing", async () => {
    const c = capture();
    const provider = scriptedProvider([
      { toolCall: { toolName: "mutate_ticket", args: { id: "TA-1", action: "delete" } } },
    ]);

    await runTurn(session(), "tenant-a", { provider, events: c.events });

    expect(c.approvals).toHaveLength(1);
    expect(c.done).toBe(0);
    expect(getApproval(c.approvals[0]!.approvalId)?.status).toBe("PENDING");
    expect(getTicket("TA-1")).toBeDefined();
    expect(all().filter((e) => e.tool === "mutate_ticket" && e.outcome === "executed")).toHaveLength(0);
  });

  it("freezes the proposed args on the approval record", async () => {
    const c = capture();
    const provider = scriptedProvider([
      {
        toolCall: {
          toolName: "mutate_ticket",
          args: { id: "TA-2", action: "update", fields: { status: "closed" } },
        },
      },
    ]);
    await runTurn(session(), "tenant-a", { provider, events: c.events });
    expect(c.approvals[0]?.frozenArgs).toEqual({
      id: "TA-2",
      action: "update",
      fields: { status: "closed" },
    });
    expect(c.approvals[0]?.serverView.diff).toBe('status: "open" → "closed"');
  });

  it("blocks a cross-tenant mutation as ticket_not_found with no approval", async () => {
    const c = capture();
    const provider = scriptedProvider([
      { toolCall: { toolName: "mutate_ticket", args: { id: "TB-2", action: "delete" } } },
      { text: "sorry" },
    ]);

    await runTurn(session(), "tenant-a", { provider, events: c.events });

    expect(c.approvals).toHaveLength(0);
    expect(c.toolResults[0]?.result).toEqual({ error: "ticket_not_found" });
    expect(all().some((e) => e.outcome === "blocked_not_found")).toBe(true);
    expect(getTicket("TB-2")).toBeDefined();
  });

  it("blocks a top-level tenantId the same way, and logs the args as proposed", async () => {
    const c = capture();
    const provider = scriptedProvider([
      {
        toolCall: {
          toolName: "mutate_ticket",
          args: { id: "TA-1", action: "update", tenantId: "tenant-b", fields: { status: "closed" } },
        },
      },
      { text: "sorry" },
    ]);

    await runTurn(session(), "tenant-a", { provider, events: c.events });

    expect(c.approvals).toHaveLength(0);
    expect(c.toolResults[0]?.result).toEqual({ error: "invalid_args" });

    // The RAW args are logged, not a sanitized copy — the smuggled key has to stay
    // readable in the audit trail or the probe is invisible to whoever reads it.
    const blocked = all().filter(
      (e) => e.tool === "mutate_ticket" && e.outcome === "blocked_invalid_args",
    );
    expect(blocked).toHaveLength(1);
    expect(blocked[0]?.args).toHaveProperty("tenantId", "tenant-b");
    expect(getTicket("TA-1")?.tenantId).toBe("tenant-a");
  });

  it("blocks mass-assignment of tenantId as invalid_args with no approval", async () => {
    const c = capture();
    const provider = scriptedProvider([
      {
        toolCall: {
          toolName: "mutate_ticket",
          args: { id: "TA-1", action: "update", fields: { tenantId: "tenant-b" } },
        },
      },
      { text: "sorry" },
    ]);

    await runTurn(session(), "tenant-a", { provider, events: c.events });

    expect(c.approvals).toHaveLength(0);
    expect(c.toolResults[0]?.result).toEqual({ error: "invalid_args" });
    expect(all().some((e) => e.outcome === "blocked_invalid_args")).toBe(true);
  });
});

describe("runTurn — empty steps", () => {
  it("finishes a contentless step without persisting an empty assistant turn", async () => {
    const c = capture();
    const s = session();
    const before = s.messages.length;

    // What a safety-blocked candidate looks like: no text, no tool call. Persisted,
    // it converts to `{role:"model", parts:[]}`, which the API rejects — wedging
    // every later turn of this session.
    await runTurn(s, "tenant-a", { provider: scriptedProvider([{}]), events: c.events });

    expect(c.done).toBe(1);
    expect(s.messages).toHaveLength(before);
    expect(s.messages.some((m) => m.role === "assistant")).toBe(false);
  });

  it("still keeps a step that has text but no tool call", async () => {
    const c = capture();
    const s = session();
    await runTurn(s, "tenant-a", { provider: scriptedProvider([{ text: "here you go" }]), events: c.events });

    expect(c.done).toBe(1);
    const assistant = s.messages.filter((m) => m.role === "assistant");
    expect(assistant).toHaveLength(1);
    expect(JSON.stringify(assistant[0]?.content)).toContain("here you go");
  });
});

describe("runTurn — step cap", () => {
  it("stops at the configured cap", async () => {
    const c = capture();
    const script = Array.from({ length: config.stepCap + 1 }, () => ({
      toolCall: { toolName: "search_tickets" as const, args: { query: "password" } },
    }));
    const s = session();

    await runTurn(s, "tenant-a", { provider: scriptedProvider(script), events: c.events });

    expect(c.toolCalls).toHaveLength(config.stepCap);
    expect(JSON.stringify(s.messages)).toContain("Step limit reached");
    expect(c.done).toBe(1);
  });
});

import { beforeEach, describe, expect, it } from "vitest";
import { setProvider } from "../../src/agent/provider.js";
import type { ModelProvider, ModelStep } from "../../src/agent/provider.js";
import { getApproval, setNow } from "../../src/approvals/registry.js";
import { config } from "../../src/config.js";
import { expireLapsedApprovals } from "../../src/http/approvals.js";
import { getSession } from "../../src/store/sessionStore.js";
import { getTicket } from "../../src/store/ticketStore.js";
import type { Session } from "../../src/types.js";
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

/** The tool call ids the session's history proposed, in order. */
function proposedCallIds(session: Session): string[] {
  const ids: string[] = [];
  for (const message of session.messages) {
    if (!Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (part.type === "tool-call") ids.push(part.toolCallId);
    }
  }
  return ids;
}

/** The tool result answering `toolCallId`, serialized — undefined if still dangling. */
function toolResultFor(session: Session, toolCallId: string): string | undefined {
  for (const message of session.messages) {
    if (!Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (part.type === "tool-result" && part.toolCallId === toolCallId) {
        return JSON.stringify(part.output);
      }
    }
  }
  return undefined;
}

/** How many tool-result parts answer `toolCallId` — should never exceed one. */
function answerCountFor(session: Session, toolCallId: string): number {
  let count = 0;
  for (const message of session.messages) {
    if (!Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (part.type === "tool-result" && part.toolCallId === toolCallId) count++;
    }
  }
  return count;
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("expired approvals leave a session usable", () => {
  beforeEach(resetWorld);

  it("repairs the dangling tool call when an approve arrives after the TTL", async () => {
    const approvalId = await openApproval("s1");
    const session = getSession("s1")!;
    const [mutateCallId] = proposedCallIds(session);
    expect(toolResultFor(session, mutateCallId!)).toBeUndefined();

    setNow(() => Date.now() + config.approvalTtlMs + 1000);
    const lapsed = await postApproval("tenant-a", "s1", approvalId, true);

    // The decision itself is still refused...
    expect(lapsed.status).toBe(409);
    expect(JSON.parse(lapsed.body)).toEqual({ error: "expired" });
    expect(executedMutations()).toHaveLength(0);
    expect(getTicket("TA-2")?.status).toBe("open");
    expect(mutateLog().filter((e) => e.outcome === "approval_expired")).toHaveLength(1);

    // ...but the transcript is repaired, so the session is not bricked. Without the
    // fill the history would end on an unanswered tool call and every later turn
    // would be rejected by the provider forever after.
    expect(toolResultFor(session, mutateCallId!)).toContain("approval_expired");

    // The reverse interleaving: the timer sweep can also fire after a decision has
    // already discovered expiry itself. The record is already EXPIRED (not PENDING),
    // so the sweep must not pick it up again — no second log entry, no second answer.
    expireLapsedApprovals();
    expect(
      mutateLog().filter((e) => e.outcome === "approval_expired" && e.approvalId === approvalId),
    ).toHaveLength(1);
    expect(answerCountFor(session, mutateCallId!)).toBe(1);

    playModel([{ text: "ok" }]);
    const next = await postChat("tenant-a", "s1", "never mind then");
    expect(next.status).toBe(200);
    expect(next.frames.some((f) => f.type === "done")).toBe(true);
  });

  it("repairs it identically when the lapsed decision is a decline", async () => {
    const approvalId = await openApproval("s1");
    const session = getSession("s1")!;
    const [mutateCallId] = proposedCallIds(session);

    setNow(() => Date.now() + config.approvalTtlMs + 1000);
    const lapsed = await postApproval("tenant-a", "s1", approvalId, false);

    // A decline that skipped the expiry check would answer 200 for the same record
    // an approve answers 409 for, and would record REJECTED rather than EXPIRED.
    expect(lapsed.status).toBe(409);
    expect(JSON.parse(lapsed.body)).toEqual({ error: "expired" });
    expect(getApproval(approvalId)?.status).toBe("EXPIRED");
    expect(mutateLog().filter((e) => e.outcome === "approval_expired")).toHaveLength(1);
    expect(mutateLog().some((e) => e.outcome === "declined_by_user")).toBe(false);

    expect(toolResultFor(session, mutateCallId!)).toContain("approval_expired");

    playModel([{ text: "ok" }]);
    const next = await postChat("tenant-a", "s1", "never mind then");
    expect(next.status).toBe(200);
    expect(next.frames.some((f) => f.type === "done")).toBe(true);
  });
});

describe("the sweep repairs abandoned approvals", () => {
  beforeEach(resetWorld);

  it("un-wedges a session whose approval nobody ever decided", async () => {
    const approvalId = await openApproval("s1");
    const session = getSession("s1")!;
    const [mutateCallId] = proposedCallIds(session);

    // A dropped SSE stream: the modal never rendered, so no decision ever arrives.
    // /chat stays refused for as long as the approval stays PENDING.
    playModel([{ text: "should never run" }]);
    const wedged = await postChat("tenant-a", "s1", "hello?");
    expect(wedged.status).toBe(409);
    expect(JSON.parse(wedged.body)).toEqual({ error: "approval_pending" });

    setNow(() => Date.now() + config.approvalTtlMs + 1000);
    expireLapsedApprovals();

    expect(getApproval(approvalId)?.status).toBe("EXPIRED");
    expect(mutateLog().filter((e) => e.outcome === "approval_expired" && e.approvalId === approvalId)).toHaveLength(1);
    expect(toolResultFor(session, mutateCallId!)).toContain("approval_expired");

    playModel([{ text: "ok" }]);
    const next = await postChat("tenant-a", "s1", "hello again");
    expect(next.status).toBe(200);
    expect(next.frames.some((f) => f.type === "done")).toBe(true);
  });

  it("a decision after the sweep is refused without a second log or answer", async () => {
    const approvalId = await openApproval("s1");
    const session = getSession("s1")!;
    const [mutateCallId] = proposedCallIds(session);

    setNow(() => Date.now() + config.approvalTtlMs + 1000);
    expireLapsedApprovals();

    const late = await postApproval("tenant-a", "s1", approvalId, true);
    // Not "expired": the sweep already moved the record past PENDING, so
    // claimPending's status check answers not_pending before it ever reaches the
    // expiry check — the same path a spent (CONSUMED/REJECTED) record takes.
    expect(late.status).toBe(409);
    expect(JSON.parse(late.body)).toEqual({ error: "not_pending" });

    expect(
      mutateLog().filter((e) => e.outcome === "approval_expired" && e.approvalId === approvalId),
    ).toHaveLength(1);

    // fillExpiredToolCall's own double-answer guard is belt-and-braces here: this
    // path is actually unreachable, since the status flip means the late decision
    // never calls fillExpiredToolCall at all — only the sweep's earlier call does.
    expect(answerCountFor(session, mutateCallId!)).toBe(1);
  });
});

describe("per-session turn guards", () => {
  beforeEach(resetWorld);

  it("refuses a new turn while an approval is pending, leaving the history untouched", async () => {
    await openApproval("s1");
    const session = getSession("s1")!;
    const before = session.messages.length;
    const snapshot = JSON.stringify(session.messages);

    playModel([{ text: "should never run" }]);
    const res = await postChat("tenant-a", "s1", "forget that, delete TA-1 instead");

    expect(res.status).toBe(409);
    expect(JSON.parse(res.body)).toEqual({ error: "approval_pending" });
    // Refused before a byte is written: a user message appended here would sit
    // after the unanswered tool call and the later approval would fill its result
    // in out of position.
    expect(session.messages).toHaveLength(before);
    expect(JSON.stringify(session.messages)).toBe(snapshot);
  });

  it("refuses a second concurrent turn on the same session but not on another", async () => {
    // A provider that parks inside step() until the test lets it go — the two
    // requests overlap by construction, with no timing assumptions.
    const gate = deferred<ModelStep>();
    const entered = deferred<void>();
    const parked: ModelProvider = {
      step: () => {
        entered.resolve();
        return gate.promise;
      },
    };
    setProvider(parked);

    const first = postChat("tenant-a", "s1", "hello");
    await entered.promise; // the first turn now definitively holds the lock

    const second = await postChat("tenant-a", "s1", "hello again");
    expect(second.status).toBe(409);
    expect(JSON.parse(second.body)).toEqual({ error: "turn_in_progress" });

    // The lock is per session, not global.
    const otherSession = postChat("tenant-a", "s2", "hello from elsewhere");

    gate.resolve({ text: "done", toolCalls: [] });
    const [firstRes, otherRes] = await Promise.all([first, otherSession]);
    expect(firstRes.status).toBe(200);
    expect(firstRes.frames.some((f) => f.type === "done")).toBe(true);
    expect(otherRes.status).toBe(200);

    // And it is released, so the session is usable again once the turn finishes.
    playModel([{ text: "again" }]);
    expect((await postChat("tenant-a", "s1", "third")).status).toBe(200);
  });
});

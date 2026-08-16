import { Hono } from "hono";
import { mutateResultMessage } from "../agent/loop.js";
import { consumeApproval, getApproval, rejectApproval, sweepApprovals } from "../approvals/registry.js";
import type { ConsumeResult } from "../approvals/registry.js";
import { append } from "../log/invocationLog.js";
import { beginTurn, endTurn, getSession } from "../store/sessionStore.js";
import type { TenantEnv } from "../tenant/middleware.js";
import { authorize, executeMutation } from "../tools/mutateTicket.js";
import type { ApprovalRecord, InvocationLogEntry, Session } from "../types.js";
import { sseEvent } from "./sse.js";
import { streamTurn } from "./turnStream.js";

export const approvalsRoute = new Hono<TenantEnv>();

/**
 * `not_found` and `forbidden` both answer 404: an attacker holding a guessed id
 * learns nothing about whether it exists under someone else's tenant.
 * Replay and expiry answer 409 — the id was real, but the decision is spent.
 */
function statusFor(reason: Exclude<ConsumeResult, { ok: true }>["reason"]): 404 | 409 {
  return reason === "not_found" || reason === "forbidden" ? 404 : 409;
}

function logMutate(
  record: ApprovalRecord,
  outcome: InvocationLogEntry["outcome"],
): void {
  append({
    ts: new Date().toISOString(),
    tenantId: record.tenantId,
    sessionId: record.sessionId,
    tool: "mutate_ticket",
    args: record.frozenArgs,
    outcome,
    approvalId: record.approvalId,
  });
}

/**
 * A lapsed decision is still a decision: the paused turn left a tool call that
 * only this endpoint can answer, and a history ending on an unanswered call makes
 * every later turn fail against the provider. So the request still answers 409
 * while the transcript is repaired here — the model simply sees that the approval
 * expired. Guarded so a retried decision cannot answer the same call twice.
 */
function fillExpiredToolCall(record: ApprovalRecord): void {
  const session = getSession(record.sessionId);
  if (!session) return;
  const answered = session.messages.some(
    (m) =>
      m.role === "tool" &&
      m.content.some((part) => part.type === "tool-result" && part.toolCallId === record.toolCallId),
  );
  if (answered) return;
  session.messages.push(
    mutateResultMessage(
      { toolCallId: record.toolCallId, toolName: "mutate_ticket" },
      { status: "approval_expired" },
    ),
  );
}

/**
 * The timer-driven half of expiry. A decision arriving late discovers expiry in
 * claimPending and repairs the session on the spot; an approval nobody ever decides
 * (modal never rendered, SSE dropped, user walked away) would otherwise stay PENDING
 * forever and leave its session wedged behind the dangling tool call. Each swept
 * record gets the same treatment a late decision would have produced: an
 * approval_expired log entry and the tool call answered in the transcript.
 *
 * Runs outside the per-session turn lock, and must stay fully synchronous to be
 * safe without one: with no `await` anywhere in this function, the whole batch
 * runs to completion between event-loop turns, so no request handler can
 * interleave with it. The lock is unnecessary in the first place because a
 * record still PENDING implies no other writer is touching it right now —
 * `runTurn` returns immediately after `createApproval`, `/chat` answers 409
 * while the tool call is unanswered, and a decision already in flight has
 * already flipped the record out of PENDING under its own lock before this
 * could see it. Adding an `await` here later (a persisted log, DB-backed
 * sessions) would silently reopen that race — keep this function synchronous.
 */
export function expireLapsedApprovals(): void {
  for (const record of sweepApprovals()) {
    // One bad record must not strand the rest of the batch: a record the sweep
    // has already flipped to EXPIRED is never PENDING again, so it would never
    // be swept a second time and would be lost for good. An uncaught throw here
    // would also kill the process, since this runs inside a setInterval callback.
    try {
      logMutate(record, "approval_expired");
      fillExpiredToolCall(record);
    } catch (err) {
      // Best-effort: the record's status is already EXPIRED regardless. But a
      // repair that failed leaves a wedged session with no log entry, so the
      // failure itself must not be invisible.
      console.error(`expireLapsedApprovals: repair failed for ${record.approvalId}`, err);
    }
  }
}

/** Fills the dangling tool result left by the paused turn, then resumes it. */
function resume(
  c: Parameters<typeof streamTurn>[0],
  session: Session,
  tenantId: string,
  record: ApprovalRecord,
  result: unknown,
): Response {
  session.messages.push(
    mutateResultMessage({ toolCallId: record.toolCallId, toolName: "mutate_ticket" }, result),
  );
  const prelude = [sseEvent("tool-result", { toolCallId: record.toolCallId, result })];
  return streamTurn(c, session, tenantId, prelude);
}

approvalsRoute.post("/approvals/:id", async (c) => {
  const id = c.req.param("id");
  const tenantId = c.get("tenantId");
  const body = (await c.req.json().catch(() => null)) as unknown;
  if (
    !body ||
    typeof body !== "object" ||
    typeof (body as { sessionId?: unknown }).sessionId !== "string" ||
    typeof (body as { approved?: unknown }).approved !== "boolean"
  ) {
    return c.json({ error: "invalid_body" }, 400);
  }
  const { sessionId, approved } = body as { sessionId: string; approved: boolean };
  const ctx = { tenantId, sessionId };

  // A decision resumes a turn, so it takes the same per-session lock /chat does —
  // the transcript repair on the expiry path included. What it must not take is
  // the dangling-call guard: this is the endpoint that answers that call.
  if (!beginTurn(sessionId)) return c.json({ error: "turn_in_progress" }, 409);
  let resumed = false;
  try {
    // The request carries a decision and nothing else — never the arguments to run.
    const outcome = approved ? consumeApproval(id, ctx) : rejectApproval(id, ctx);
    if (!outcome.ok) {
      if (outcome.reason === "expired") {
        // Both decision paths land here, so an expired decline is repaired too.
        const record = getApproval(id);
        if (record) {
          logMutate(record, "approval_expired");
          fillExpiredToolCall(record);
        }
      }
      return c.json({ error: outcome.reason }, statusFor(outcome.reason));
    }

    const record = outcome.record;
    const session = getSession(record.sessionId);
    if (!session) {
      // The record is already spent (CONSUMED or REJECTED) — a decided approval
      // that executed nothing must still leave a log entry, not vanish silently.
      // Approve and decline deliberately log the same outcome here: nothing
      // executed either way, and the registry's CONSUMED/REJECTED status on the
      // record itself is what records which direction the decision went.
      logMutate(record, "blocked_session_lost");
      return c.json({ error: "not_found" }, 404);
    }

    if (!approved) {
      logMutate(record, "declined_by_user");
      resumed = true;
      return resume(c, session, tenantId, record, { status: "declined_by_user" });
    }

    // Ownership check #2: re-verified against the live store immediately before the
    // write. The ticket may have moved or vanished while the human was deciding.
    const authz = authorize(record.tenantId, record.frozenArgs.id);
    if (!authz.ok) {
      logMutate(record, "blocked_not_found");
      resumed = true;
      return resume(c, session, tenantId, record, { error: "ticket_not_found" });
    }

    // The modal rendered facts from a specific version of the ticket. If the ticket
    // moved while the human was deciding, the click approved facts that no longer
    // hold — block execution and let the model re-propose against the current state,
    // which produces a fresh modal with fresh facts. Applies uniformly to update and
    // delete: the human approved "delete <this title, this status>", not "delete
    // whatever this id points at now". This comparison and the write below must
    // stay free of `await` between them — same discipline as the registry's atomic
    // consume — or an await inserted here would reopen the TOCTOU this guard closes.
    if (authz.ticket.updatedAt !== record.frozenUpdatedAt) {
      logMutate(record, "blocked_stale");
      resumed = true;
      return resume(c, session, tenantId, record, { error: "ticket_changed" });
    }

    const executed = executeMutation(record.frozenArgs);
    logMutate(record, "executed");
    resumed = true;
    return resume(c, session, tenantId, record, executed);
  } finally {
    // Only a resumed turn reaches streamTurn, which is what releases the lock.
    if (!resumed) endTurn(sessionId);
  }
});

import { randomUUID } from "node:crypto";
import { config } from "../config.js";
import type { ApprovalRecord, MutateArgs, ServerView } from "../types.js";

const store = new Map<string, ApprovalRecord>();

/** Injectable clock so expiry can be tested without sleeping. */
let now: () => number = Date.now;
export function setNow(fn: () => number): void {
  now = fn;
}

export function resetApprovals(): void {
  store.clear();
}

export function createApproval(input: {
  tenantId: string;
  sessionId: string;
  toolCallId: string;
  frozenArgs: MutateArgs;
  frozenUpdatedAt: string;
  serverView: ServerView;
}): ApprovalRecord {
  const created = now();
  const record: ApprovalRecord = {
    approvalId: randomUUID(),
    tenantId: input.tenantId,
    sessionId: input.sessionId,
    toolCallId: input.toolCallId,
    frozenArgs: input.frozenArgs,
    frozenUpdatedAt: input.frozenUpdatedAt,
    serverView: input.serverView,
    status: "PENDING",
    createdAt: new Date(created).toISOString(),
    expiresAt: new Date(created + config.approvalTtlMs).toISOString(),
  };
  store.set(record.approvalId, record);
  return record;
}

export function getApproval(id: string): ApprovalRecord | undefined {
  return store.get(id);
}

export type ConsumeResult =
  | { ok: true; record: ApprovalRecord }
  | { ok: false; reason: "not_found" | "forbidden" | "expired" | "not_pending" };

/**
 * Existence, ownership, status and expiry — the checks both decisions share. Approving
 * and declining must agree on every one of them: a decline that skipped expiry would
 * answer 200 for the same lapsed record an approve answers 409 for.
 *
 * Status is checked before expiry, and the order is load-bearing: a spent record stays
 * `not_pending` however long ago it was decided. Calling it "expired" once the TTL had
 * passed would have the caller log `approval_expired` for a mutation that actually ran —
 * once per replay, in an append-only log.
 *
 * `not_pending` now also covers a record the sweep expired before this decision arrived
 * — status is EXPIRED, not PENDING, same as CONSUMED or REJECTED. The tempting fix is to
 * special-case EXPIRED status here and return `expired` instead of `not_pending`, so a
 * late decision's error message matches what actually happened — resist it. `expired` is
 * the signal the caller uses to log `approval_expired` and repair the transcript; the
 * sweep has already done both for this record, so doing them again here would write a
 * second `approval_expired` entry and re-run the double-answer race on every late replay.
 */
function claimPending(
  id: string,
  ctx: { tenantId: string; sessionId: string },
): { ok: true; record: ApprovalRecord } | Exclude<ConsumeResult, { ok: true }> {
  const r = store.get(id);
  if (!r) return { ok: false, reason: "not_found" };
  if (r.tenantId !== ctx.tenantId || r.sessionId !== ctx.sessionId) {
    return { ok: false, reason: "forbidden" };
  }
  if (r.status !== "PENDING") return { ok: false, reason: "not_pending" };
  if (now() > Date.parse(r.expiresAt)) {
    r.status = "EXPIRED";
    return { ok: false, reason: "expired" };
  }
  return { ok: true, record: r };
}

/**
 * Single-use. The status flip is synchronous with the checks in `claimPending` — there
 * is deliberately no `await` between the PENDING check and the CONSUMED write, so a
 * replayed or double-clicked approval can never both pass the check.
 */
export function consumeApproval(
  id: string,
  ctx: { tenantId: string; sessionId: string },
): ConsumeResult {
  const claimed = claimPending(id, ctx);
  if (!claimed.ok) return claimed;
  claimed.record.status = "CONSUMED";
  return claimed;
}

/** The declining half of the same claim: identical guards, opposite terminal status. */
export function rejectApproval(
  id: string,
  ctx: { tenantId: string; sessionId: string },
): ConsumeResult {
  const claimed = claimPending(id, ctx);
  if (!claimed.ok) return claimed;
  claimed.record.status = "REJECTED";
  return claimed;
}

/**
 * Marks lapsed PENDING records EXPIRED and returns exactly those records — the
 * consume path enforces expiry regardless, so this is only for approvals nobody
 * ever decides. The registry owns the status flip alone; it is the caller's job to
 * do anything that flip implies (an audit log entry, repairing the session's
 * dangling tool call) — this function does not know about either.
 */
export function sweepApprovals(): ApprovalRecord[] {
  const t = now();
  const lapsed: ApprovalRecord[] = [];
  for (const r of store.values()) {
    if (r.status === "PENDING" && t > Date.parse(r.expiresAt)) {
      r.status = "EXPIRED";
      lapsed.push(r);
    }
  }
  return lapsed;
}

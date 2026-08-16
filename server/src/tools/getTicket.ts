import { append } from "../log/invocationLog.js";
import type { TicketStatus } from "../types.js";
import { authorize } from "./mutateTicket.js";

export type GetTicketResult =
  | {
      id: string;
      title: string;
      status: TicketStatus;
      description: string;
      createdAt: string;
      updatedAt: string;
    }
  | { error: "ticket_not_found" };

/**
 * The depth counterpart to `runSearch`: one ticket, full description, no cap.
 *
 * Taking an `id` and nothing else is what bounds this. Search returns up to
 * `searchResultCap` rows, so lifting its snippet cap would put ten full bodies
 * of attacker-controlled text into context at once; a `full: true` flag on
 * search would hand the model that same path on demand. Reading one ticket per
 * call cannot fan out — the step cap bounds how many such reads a steered model
 * can chain in a turn.
 *
 * `tenantId` comes from the verified request context, never from `args`. Reuses
 * `authorize` so a cross-tenant id and a nonexistent one are indistinguishable
 * here for the same reason they are on the mutate path.
 */
export function runGetTicket(
  tenantId: string,
  args: { id: string },
  ctx: { sessionId: string },
): GetTicketResult {
  const authz = authorize(tenantId, args.id);
  append({
    ts: new Date().toISOString(),
    tenantId,
    sessionId: ctx.sessionId,
    tool: "get_ticket",
    args,
    outcome: authz.ok ? "executed" : "blocked_not_found",
  });
  if (!authz.ok) return { error: "ticket_not_found" };
  const { id, title, status, description, createdAt, updatedAt } = authz.ticket;
  return { id, title, status, description, createdAt, updatedAt };
}

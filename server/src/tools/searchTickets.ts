import { config } from "../config.js";
import { append } from "../log/invocationLog.js";
import { searchRaw } from "../store/ticketStore.js";
import type { TicketStatus } from "../types.js";

export type SearchHit = {
  id: string;
  title: string;
  status: TicketStatus;
  snippet: string;
  /**
   * Whether `snippet` lost text to the cap. Without it the model cannot tell a
   * complete short description from a cut long one — it sees a field named
   * "snippet" and assumes text was withheld, so it reports content it is
   * actually holding as unavailable. `false` also tells it not to spend a step
   * on `get_ticket` for a description it already has in full.
   */
  truncated: boolean;
};

/**
 * `tenantId` comes from the verified request context, never from `args`. The
 * model's `query` is a text filter and nothing more.
 */
export function runSearch(
  tenantId: string,
  args: { query: string },
  ctx: { sessionId: string },
): SearchHit[] {
  const hits = searchRaw(tenantId, args.query).map(
    (t): SearchHit => ({
      id: t.id,
      title: t.title,
      status: t.status,
      snippet: t.description.slice(0, config.snippetMax),
      // Strictly greater: a description of exactly snippetMax survives slice()
      // whole, so `>=` would claim text was withheld when none was.
      truncated: t.description.length > config.snippetMax,
    }),
  );
  append({
    ts: new Date().toISOString(),
    tenantId,
    sessionId: ctx.sessionId,
    tool: "search_tickets",
    args,
    outcome: "executed",
  });
  return hits;
}

import { config } from "../config.js";
import type { Ticket } from "../types.js";
import { seedTickets } from "./seed.js";

let tickets: Ticket[] = seedTickets();

export function resetTickets(seed?: Ticket[]): void {
  tickets = seed ? seed.map((t) => ({ ...t })) : seedTickets();
}

/** No tenant filter here on purpose — every caller scopes explicitly. */
export function getTicket(id: string): Ticket | undefined {
  return tickets.find((t) => t.id === id);
}

/**
 * Words carrying no signal in a ticket search. A model asked to "show me all
 * tickets" sends that whole phrase; without this the query matches nothing and
 * the agent reports an empty ticket system. Stripping them leaves no terms,
 * which lists everything — the answer the user actually wanted.
 */
const STOPWORDS = new Set([
  "a", "all", "an", "and", "any", "are", "do", "find", "for", "get", "give", "have", "i", "is",
  "list", "me", "mine", "my", "of", "please", "search", "see", "show", "the", "there", "ticket",
  "tickets", "to", "view", "what", "which",
]);

/**
 * Trims punctuation off each end of a token. The character class must stay
 * Unicode-aware: an ASCII one strips a non-Latin word ("парола") down to "",
 * which drops it as a term — and a query made only of such words would then
 * look stopword-only to searchRaw and list the tenant's whole ticket set as
 * matches for a query that matched nothing.
 */
function terms(query: string): string[] {
  return query
    .toLowerCase()
    .split(/\s+/)
    .map((t) => t.replace(/^[^\p{L}\p{N}-]+|[^\p{L}\p{N}-]+$/gu, ""))
    .filter((t) => t.length > 0 && !STOPWORDS.has(t));
}

/**
 * Tenant filter is applied unconditionally and is derived from the caller's
 * request context, never from model-supplied arguments. A `query` naming
 * another tenant changes nothing here — the text match below only ever runs
 * against rows that already passed the tenant check.
 *
 * Matching is AND-over-terms rather than whole-phrase, so word order does not
 * matter ("reset password" finds the same ticket as "password reset"). A query
 * with no meaningful terms lists the tenant's tickets.
 */
export function searchRaw(tenantId: string, query: string): Ticket[] {
  const needles = terms(query);
  return tickets
    .filter((t) => t.tenantId === tenantId)
    .filter((t) => {
      if (needles.length === 0) return true;
      const haystack = `${t.id} ${t.title} ${t.description}`.toLowerCase();
      return needles.every((needle) => haystack.includes(needle));
    })
    .slice(0, config.searchResultCap);
}

export function applyUpdate(
  id: string,
  fields: Partial<Pick<Ticket, "title" | "status" | "description">>,
): Ticket {
  const ticket = tickets.find((t) => t.id === id);
  if (!ticket) throw new Error(`applyUpdate: unknown ticket ${id}`);
  if (fields.title !== undefined) ticket.title = fields.title;
  if (fields.status !== undefined) ticket.status = fields.status;
  if (fields.description !== undefined) ticket.description = fields.description;
  ticket.updatedAt = new Date().toISOString();
  return ticket;
}

export function removeTicket(id: string): void {
  tickets = tickets.filter((t) => t.id !== id);
}

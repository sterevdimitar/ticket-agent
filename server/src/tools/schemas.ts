import { tool } from "ai";
import { z } from "zod";

export const searchArgs = z
  .object({
    query: z.string().max(200),
  })
  // .strict() for the same reason as below: a smuggled key is a logged rejection,
  // not a silent strip. Search takes `query` and nothing else; the tenant is the
  // server's, never the model's.
  .strict();

export const getTicketArgs = z
  .object({
    id: z.string(),
  })
  // .strict() for the same reason as the others: a smuggled `tenantId` is a
  // logged rejection, not a silent strip. The tenant is the server's.
  .strict();

export const mutateArgs = z
  .object({
    id: z.string(),
    action: z.enum(["update", "delete"]),
    fields: z
      .object({
        title: z.string().max(200).optional(),
        status: z.enum(["open", "in_progress", "closed"]).optional(),
        description: z.string().max(5000).optional(),
      })
      .strict()
      .optional(),
  })
  // .strict() at BOTH levels: an unknown key such as `tenantId` is a hard rejection,
  // not a silent strip — whether it rides in `fields` or alongside them at the top.
  // No mutation can re-tenant or re-target a ticket, and because a strip would leave
  // the sanitized args in the log looking like an ordinary update, rejecting instead
  // is what keeps the probe visible in the audit trail.
  .strict();

/**
 * Declared WITHOUT `execute` handlers. The SDK is a provider/streaming library
 * here; it can describe these tools to the model but can never run one. Every
 * proposed call goes through our loop and its gates.
 */
export const toolDefs = {
  search_tickets: tool({
    description:
      "Search tickets belonging to the current tenant. Returns id, title, status and a short " +
      "snippet for each match, plus `truncated` saying whether that snippet lost text to the " +
      "cap. Pass an EMPTY query string to list every ticket. Otherwise pass " +
      "one or two keywords (e.g. 'password', 'billing') — not a sentence. Matching requires " +
      "every keyword to appear in the ticket, so extra words narrow the results.",
    inputSchema: searchArgs,
  }),
  get_ticket: tool({
    description:
      "Read one ticket in full by id, including its complete description. Use this only when " +
      "a search hit came back with truncated=true, or when the user asks for the full text of " +
      "a specific ticket. If truncated=false the search snippet is already the entire " +
      "description and calling this adds nothing.",
    inputSchema: getTicketArgs,
  }),
  mutate_ticket: tool({
    description:
      "Propose a change to one ticket (update its title/status/description, or delete it). " +
      "Every mutation is held for explicit human approval before it runs.",
    inputSchema: mutateArgs,
  }),
};

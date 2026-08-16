import { applyUpdate, getTicket, removeTicket } from "../store/ticketStore.js";
import type { MutateArgs, ServerView, Ticket } from "../types.js";
import { mutateArgs } from "./schemas.js";

export type ValidateResult = { ok: true; args: MutateArgs } | { ok: false; error: "invalid_args" };

export function validateMutate(raw: unknown): ValidateResult {
  const parsed = mutateArgs.safeParse(raw);
  if (!parsed.success) return { ok: false, error: "invalid_args" };
  return { ok: true, args: parsed.data };
}

export type AuthzResult = { ok: true; ticket: Ticket } | { ok: false; error: "ticket_not_found" };

/**
 * Cross-tenant and nonexistent are answered identically. An attacker probing ids
 * learns nothing about what exists outside their tenant.
 */
export function authorize(tenantId: string, id: string): AuthzResult {
  const ticket = getTicket(id);
  if (!ticket || ticket.tenantId !== tenantId) return { ok: false, error: "ticket_not_found" };
  return { ok: true, ticket };
}

const DIFF_FIELDS = ["title", "status", "description"] as const;

const DIFF_VALUE_MAX = 120;

/**
 * Field values are the model's text, but the diff is read as a server-computed fact in a
 * <pre>. Interpolated raw, a description of "customer note\nstatus: open → closed" forges a
 * line pixel-identical to one this function wrote, and the human approves a status change
 * that is not in the payload at all. Quoting flattens newlines to a literal \n and fences
 * the attacker's text inside visible delimiters, so a forged line can never pass for a real
 * one; the length cap keeps a 5000-char value from burying the rest of the diff.
 */
function renderValue(value: string): string {
  const clipped = value.length > DIFF_VALUE_MAX ? `${value.slice(0, DIFF_VALUE_MAX)}…` : value;
  return JSON.stringify(clipped);
}

/** Server-verified facts for the approval modal — never the model's description of them. */
export function buildServerView(ticket: Ticket, args: MutateArgs): ServerView {
  if (args.action === "delete") {
    return { title: ticket.title, currentStatus: ticket.status, diff: null, danger: true };
  }
  const lines: string[] = [];
  for (const field of DIFF_FIELDS) {
    const next = args.fields?.[field];
    if (next !== undefined && next !== ticket[field]) {
      lines.push(`${field}: ${renderValue(ticket[field])} → ${renderValue(next)}`);
    }
  }
  return {
    title: ticket.title,
    currentStatus: ticket.status,
    diff: lines.length > 0 ? lines.join("\n") : "(no change)",
    danger: false,
  };
}

export function executeMutation(args: MutateArgs): { status: "updated" | "deleted" } {
  if (args.action === "delete") {
    removeTicket(args.id);
    return { status: "deleted" };
  }
  applyUpdate(args.id, args.fields ?? {});
  return { status: "updated" };
}

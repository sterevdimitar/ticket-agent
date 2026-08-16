import type { ModelMessage } from "ai";

/** Model-facing conversation history entry (AI SDK message format). */
export type Message = ModelMessage;

export type TicketStatus = "open" | "in_progress" | "closed";

export type Ticket = {
  id: string;
  tenantId: string;
  title: string;
  status: TicketStatus;
  description: string;
  createdAt: string;
  updatedAt: string;
};

/**
 * Arguments for a proposed mutation. `fields` is an allowlist — `id` and
 * `tenantId` are deliberately absent so no update can re-tenant a ticket.
 */
export type MutateArgs = {
  id: string;
  action: "update" | "delete";
  fields?: Partial<Pick<Ticket, "title" | "status" | "description">>;
};

export type ApprovalRecord = {
  approvalId: string;
  tenantId: string;
  sessionId: string;
  toolCallId: string;
  /** Frozen at proposal time. The approve request carries no args — this is what executes. */
  frozenArgs: MutateArgs;
  /** The ticket's `updatedAt` at proposal time — the version the modal's facts described. */
  frozenUpdatedAt: string;
  /** Server-verified facts rendered in the modal, never the model's prose. */
  serverView: {
    title: string;
    currentStatus: TicketStatus;
    diff: string | null;
    danger: boolean;
  };
  status: "PENDING" | "CONSUMED" | "REJECTED" | "EXPIRED";
  createdAt: string;
  expiresAt: string;
};

export type ServerView = ApprovalRecord["serverView"];

export type Session = {
  sessionId: string;
  tenantId: string;
  messages: Message[];
  createdAt: string;
};

export type InvocationLogEntry = {
  ts: string;
  tenantId: string;
  sessionId: string;
  /** Usually `search_tickets` or `mutate_ticket`; a hallucinated name is recorded verbatim so the log shows what a compromised model actually attempted. */
  tool: string;
  args: unknown;
  outcome:
    | "executed"
    | "blocked_not_found"
    | "blocked_forbidden_field"
    | "blocked_invalid_args"
    | "declined_by_user"
    | "approval_expired"
    /** The ticket changed between proposal and approval; the human approved facts, not an id. */
    | "blocked_stale"
    /** Proposed by the model in a multi-call step but never honored (invariant #7). */
    | "dropped_parallel_call"
    /** The proposed tool name was not one of the known tools; answered with an error, never silently discarded. */
    | "blocked_unknown_tool"
    /** The approval was decided but its session no longer exists; nothing executed. */
    | "blocked_session_lost";
  approvalId?: string;
};

import { createApproval } from "../approvals/registry.js";
import { config } from "../config.js";
import { append } from "../log/invocationLog.js";
import { runGetTicket } from "../tools/getTicket.js";
import { authorize, buildServerView, validateMutate } from "../tools/mutateTicket.js";
import { getTicketArgs, searchArgs } from "../tools/schemas.js";
import { runSearch } from "../tools/searchTickets.js";
import type { ApprovalRecord, InvocationLogEntry, Message, Session } from "../types.js";
import { wrapUntrusted } from "./prompt.js";
import type { ModelProvider, ToolCallProposal } from "./provider.js";

export interface LoopEvents {
  onTextDelta(text: string): void;
  onToolCall(call: ToolCallProposal): void;
  onToolResult(toolCallId: string, result: unknown): void;
  onApprovalRequired(record: ApprovalRecord): void;
  onDone(): void;
}

export interface TurnDeps {
  provider: ModelProvider;
  events: LoopEvents;
}

export function assistantMessage(text: string, call?: ToolCallProposal): Message {
  const content: Array<
    | { type: "text"; text: string }
    | { type: "tool-call"; toolCallId: string; toolName: string; input: unknown }
  > = [];
  if (text) content.push({ type: "text", text });
  if (call) {
    content.push({
      type: "tool-call",
      toolCallId: call.toolCallId,
      toolName: call.toolName,
      input: call.args,
    });
  }
  return { role: "assistant", content } as Message;
}

function resultMessage(
  call: Pick<ToolCallProposal, "toolCallId" | "toolName">,
  value: string,
): Message {
  return {
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolCallId: call.toolCallId,
        toolName: call.toolName,
        output: { type: "text", value },
      },
    ],
  } as Message;
}

/** Tool output enters the model's context spotlighted as untrusted data. */
export function toolResultMessage(
  call: Pick<ToolCallProposal, "toolCallId" | "toolName">,
  result: unknown,
): Message {
  return resultMessage(call, wrapUntrusted(JSON.stringify(result)));
}

/**
 * The one tool result that is NOT spotlighted. Every `mutate_ticket` result is a
 * fixed, server-authored verdict — `{status:"deleted"}`, `declined_by_user`,
 * `ticket_changed` — with no customer or attacker text anywhere in it. Wrapping it
 * told the model its own outcome was "untrusted data written by customers or
 * attackers", so the model would not report the outcome and instead fell back on
 * the system prompt's only mutate fact ("held for explicit human approval"),
 * announcing a pending approval to a user who had already approved. A spotlight
 * around text nobody untrusted wrote buys nothing and costs the confirmation.
 *
 * The safety property this must not weaken: nothing here is model- or
 * customer-supplied. Keep it that way — if a mutate result ever starts carrying
 * ticket text (a title, a description echo), it belongs back in the envelope.
 */
export function mutateResultMessage(
  call: Pick<ToolCallProposal, "toolCallId" | "toolName">,
  result: unknown,
): Message {
  return resultMessage(call, JSON.stringify(result));
}

function logMutate(
  session: Session,
  tenantId: string,
  args: unknown,
  outcome: InvocationLogEntry["outcome"],
  approvalId?: string,
): void {
  append({
    ts: new Date().toISOString(),
    tenantId,
    sessionId: session.sessionId,
    tool: "mutate_ticket",
    args,
    outcome,
    ...(approvalId ? { approvalId } : {}),
  });
}

/**
 * Our loop, not the SDK's. Three properties here are load-bearing:
 *
 *  - At most one tool call is honored per model step. If the model proposes
 *    several, the rest are dropped and never enter the history, so a "delete
 *    everything" burst degrades into sequential single proposals, each needing
 *    its own human approval, all bounded by the step cap.
 *  - A mutate proposal ENDS the turn. The turn returns with the tool call left
 *    deliberately unanswered in `session.messages`; only the approval endpoint
 *    can fill that result in and resume. `provider.step` must never be called
 *    again while that result is missing.
 *  - A tool call whose name is not one of the two known tools is logged
 *    (`blocked_unknown_tool`) and answered with an error, never silently
 *    dropped — and the mutate gate below is reachable only by a call actually
 *    named `mutate_ticket`, so a hallucinated name with mutate-shaped args can
 *    never be misattributed as a real mutate proposal.
 */
export async function runTurn(
  session: Session,
  tenantId: string,
  { provider, events }: TurnDeps,
): Promise<void> {
  for (let step = 0; step < config.stepCap; step++) {
    const { text, toolCalls } = await provider.step(session.messages, {
      onTextDelta: events.onTextDelta,
    });

    const call = toolCalls[0];

    // Invariant #7 honors at most one call per step, but the ones we drop are
    // still things a compromised model attempted. Recording them keeps the audit
    // trail complete: a steered "delete everything" burst leaves five entries,
    // not one, even though only the first ever reached a gate.
    for (const dropped of toolCalls.slice(1)) {
      append({
        ts: new Date().toISOString(),
        tenantId,
        sessionId: session.sessionId,
        tool: dropped.toolName,
        args: dropped.args,
        outcome: "dropped_parallel_call",
      });
    }

    if (!call) {
      // A step with no text and no call would persist a contentless assistant
      // turn, which the Gemini converter renders as `{role:"model", parts:[]}`
      // and the API rejects. One safety-blocked candidate would then wedge every
      // later turn of this session, so an empty turn never enters the history.
      if (text) session.messages.push(assistantMessage(text));
      events.onDone();
      return;
    }

    session.messages.push(assistantMessage(text, call));
    events.onToolCall(call);

    // The mutate path below must be reachable only by a call actually named
    // `mutate_ticket` — without this check a hallucinated name whose args happen
    // to fit the mutate schema would flow into the approval gate under the wrong
    // name, and the log would misattribute what the model asked for. The tool
    // result still answers the call so the history stays well-formed (every tool
    // call gets a result) and the model may correct itself on the next step.
    if (
      call.toolName !== "search_tickets" &&
      call.toolName !== "get_ticket" &&
      call.toolName !== "mutate_ticket"
    ) {
      append({
        ts: new Date().toISOString(),
        tenantId,
        sessionId: session.sessionId,
        tool: call.toolName,
        args: call.args,
        outcome: "blocked_unknown_tool",
      });
      const result = { error: "unknown_tool" as const };
      session.messages.push(toolResultMessage(call, result));
      events.onToolResult(call.toolCallId, result);
      continue;
    }

    if (call.toolName === "search_tickets") {
      const parsed = searchArgs.safeParse(call.args);
      const result = parsed.success
        ? runSearch(tenantId, parsed.data, { sessionId: session.sessionId })
        : { error: "invalid_args" as const };
      if (!parsed.success) {
        append({
          ts: new Date().toISOString(),
          tenantId,
          sessionId: session.sessionId,
          tool: "search_tickets",
          args: call.args,
          outcome: "blocked_invalid_args",
        });
      }
      session.messages.push(toolResultMessage(call, result));
      events.onToolResult(call.toolCallId, result);
      continue;
    }

    // A read, so it never reaches the approval gate — but it is the one tool that
    // puts an uncapped description into context, so its args are validated on the
    // same terms as the others and a rejection is logged, not silently stripped.
    if (call.toolName === "get_ticket") {
      const parsed = getTicketArgs.safeParse(call.args);
      const result = parsed.success
        ? runGetTicket(tenantId, parsed.data, { sessionId: session.sessionId })
        : { error: "invalid_args" as const };
      if (!parsed.success) {
        append({
          ts: new Date().toISOString(),
          tenantId,
          sessionId: session.sessionId,
          tool: "get_ticket",
          args: call.args,
          outcome: "blocked_invalid_args",
        });
      }
      session.messages.push(toolResultMessage(call, result));
      events.onToolResult(call.toolCallId, result);
      continue;
    }

    if (call.toolName === "mutate_ticket") {
      const valid = validateMutate(call.args);
      if (!valid.ok) {
        logMutate(session, tenantId, call.args, "blocked_invalid_args");
        const result = { error: "invalid_args" as const };
        session.messages.push(mutateResultMessage(call, result));
        events.onToolResult(call.toolCallId, result);
        continue;
      }

      // Ownership check #1: before a human is ever asked. Re-checked after approval.
      const authz = authorize(tenantId, valid.args.id);
      if (!authz.ok) {
        logMutate(session, tenantId, valid.args, "blocked_not_found");
        const result = { error: "ticket_not_found" as const };
        session.messages.push(mutateResultMessage(call, result));
        events.onToolResult(call.toolCallId, result);
        continue;
      }

      const record = createApproval({
        tenantId,
        sessionId: session.sessionId,
        toolCallId: call.toolCallId,
        frozenArgs: valid.args,
        frozenUpdatedAt: authz.ticket.updatedAt,
        serverView: buildServerView(authz.ticket, valid.args),
      });
      events.onApprovalRequired(record);
      return; // PAUSE — resumed only by POST /approvals/:id
    }

    // Exhaustiveness backstop: the unknown-name guard plus the two branches
    // above exhaust every value `call.toolName` can hold here, and each path
    // through them ends in `continue` or `return`. If a third known name is
    // ever added without a branch for it, this narrows to something other
    // than `never` and the build breaks instead of silently falling through.
    const _exhaustive: never = call.toolName;
    throw new Error(`unhandled known tool: ${String(_exhaustive)}`);
  }

  session.messages.push(assistantMessage("Step limit reached; stopping."));
  events.onDone();
}

import type { Context } from "hono";
import { streamSSE } from "hono/streaming";
import type { SSEStreamingApi } from "hono/streaming";
import { runTurn } from "../agent/loop.js";
import type { LoopEvents } from "../agent/loop.js";
import { getProvider } from "../agent/provider.js";
import { endTurn } from "../store/sessionStore.js";
import type { Session } from "../types.js";
import { sseEvent } from "./sse.js";

/**
 * Streams one turn as SSE. Frames are serialized through a promise chain so the
 * loop's synchronous event callbacks cannot interleave writes out of order.
 *
 * `prelude` lets the approval endpoint emit the tool result it just produced
 * before the model resumes.
 *
 * Callers take the per-session turn lock before handing the session over; this is
 * where it is released, so every route that starts a turn releases it the same way
 * — including one that failed mid-stream.
 */
export function streamTurn(
  c: Context,
  session: Session,
  tenantId: string,
  prelude: string[] = [],
): Response {
  return streamSSE(c, async (stream: SSEStreamingApi) => {
    let chain: Promise<void> = Promise.resolve();
    const write = (frame: string) => {
      chain = chain.then(async () => {
        await stream.write(frame);
      });
    };

    for (const frame of prelude) write(frame);

    const events: LoopEvents = {
      onTextDelta: (text) => write(sseEvent("text-delta", { text })),
      onToolCall: (call) =>
        write(
          sseEvent("tool-call", {
            toolCallId: call.toolCallId,
            toolName: call.toolName,
            args: call.args,
          }),
        ),
      onToolResult: (toolCallId, result) =>
        write(sseEvent("tool-result", { toolCallId, result })),
      onApprovalRequired: (record) =>
        write(
          sseEvent("approval-required", {
            approvalId: record.approvalId,
            action: record.frozenArgs.action,
            ticketId: record.frozenArgs.id,
            serverView: record.serverView,
          }),
        ),
      onDone: () => write(sseEvent("done", {})),
    };

    try {
      try {
        await runTurn(session, tenantId, { provider: getProvider(), events });
      } catch (err) {
        write(sseEvent("error", { message: err instanceof Error ? err.message : "turn_failed" }));
      }
      await chain;
    } finally {
      endTurn(session.sessionId);
    }
  });
}

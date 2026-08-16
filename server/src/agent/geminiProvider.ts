import { google } from "@ai-sdk/google";
import { type LanguageModel, streamText } from "ai";
import { config } from "../config.js";
import { toolDefs } from "../tools/schemas.js";
import type { Message } from "../types.js";
import type { ModelProvider, ModelStep, StepHandlers, ToolCallProposal } from "./provider.js";

/**
 * Under AI SDK v7 the `fullStream` parts type as `any` at this call site, so the
 * compiler no longer checks the field names we read off them. These guards put
 * that check back at runtime: if a future SDK version renames `text`, `input`, or
 * `toolCallId`, we fail loudly here instead of silently reading `undefined` and
 * proposing a tool call with no arguments.
 */
function shapeError(kind: string, part: Record<string, unknown>): Error {
  return new Error(
    `AI SDK stream shape changed: '${kind}' part has keys [${Object.keys(part).join(", ")}]. ` +
      "geminiProvider needs updating for this SDK version.",
  );
}

function readTextDelta(part: Record<string, unknown>): string {
  if (typeof part.text !== "string") throw shapeError("text-delta", part);
  return part.text;
}

function readToolCall(part: Record<string, unknown>): ToolCallProposal {
  const { toolCallId, toolName } = part;
  if (typeof toolCallId !== "string" || typeof toolName !== "string" || !("input" in part)) {
    throw shapeError("tool-call", part);
  }
  return {
    toolCallId,
    toolName,
    args: part.input,
  };
}

/**
 * One model step per call — no multi-step, no `execute` handlers. The SDK streams
 * tokens and reports which tools the model *wants* to call; our loop decides what
 * actually happens.
 *
 * Note on v7: its built-in tool-approval machinery (`toolApproval`,
 * `experimental_toolApprovalSecret`) is deliberately unused. It exists to gate the
 * SDK's own `execute` handlers, which we do not have — and its signature covers
 * only (approvalId, toolCallId, toolName, input), giving no single-use, TTL, or
 * tenant/session binding. Those live in our approval registry instead.
 *
 * Parameterized by the model instance so tests can drive the REAL SDK pipeline
 * (prompt standardization, stream-part shaping) against a mock model, with only
 * the transport faked. The Gemini binding below is the sole production caller.
 */
export function aiSdkProvider(model: LanguageModel): ModelProvider {
  return {
    async step(messages: Message[], handlers: StepHandlers): Promise<ModelStep> {
      // AI SDK v7 rejects system messages inside `messages` (allowSystemInMessages
      // defaults to false) and requires them via `instructions`. We keep the system
      // prompt in server-held session history, so the split happens here, at the
      // adapter, rather than changing what a session stores.
      const instructions = messages
        .filter((m) => m.role === "system")
        .map((m) => (typeof m.content === "string" ? m.content : ""))
        .filter((c) => c.length > 0)
        .join("\n\n");
      const conversation = messages.filter((m) => m.role !== "system");

      const result = streamText({
        model,
        ...(instructions ? { instructions } : {}),
        messages: conversation,
        tools: toolDefs,
        toolChoice: "auto",
        providerOptions: {
          google: { thinkingConfig: { thinkingBudget: 0 } },
        },
      });

      let text = "";
      const toolCalls: ToolCallProposal[] = [];

      for await (const rawPart of result.fullStream) {
        const part = rawPart as Record<string, unknown>;
        if (part.type === "text-delta") {
          const delta = readTextDelta(part);
          text += delta;
          handlers.onTextDelta?.(delta);
        } else if (part.type === "error") {
          // streamText reports failures as a stream part rather than throwing. Without
          // this, a bad key or a refused request is indistinguishable from the model
          // choosing to say nothing, and the turn ends "successfully" having done
          // nothing at all.
          const e = part.error;
          throw new Error(`model request failed: ${e instanceof Error ? e.message : String(e)}`);
        } else if (part.type === "tool-call") {
          // Forward every tool-call part, hallucinated names included — the loop
          // decides which names are known tools and logs the rest.
          toolCalls.push(readToolCall(part));
        }
      }

      return { text, toolCalls };
    },
  };
}

/** Production binding. `config.geminiModel` keeps honoring GEMINI_MODEL. */
export const geminiProvider: ModelProvider = aiSdkProvider(google(config.geminiModel));

import type { Message } from "../types.js";
import type { ModelProvider, ModelStep, StepHandlers, ToolCallProposal } from "./provider.js";

export type ScriptedToolCall = Omit<ToolCallProposal, "toolCallId">;

export type ScriptedStep = {
  text?: string;
  toolCall?: ScriptedToolCall;
  /** Lets a test play a model that proposes several calls in a single step. */
  toolCalls?: ScriptedToolCall[];
};

/**
 * A fully scripted stand-in for the model. The security tests use it to play a
 * completely compromised model deterministically, with no API key: whatever the
 * script says, the gates still have to hold.
 */
export function scriptedProvider(script: ScriptedStep[]): ModelProvider {
  const remaining = [...script];
  let callCounter = 0;

  return {
    async step(_messages: Message[], handlers: StepHandlers): Promise<ModelStep> {
      const next = remaining.shift();
      if (!next) return { text: "", toolCalls: [] };

      const text = next.text ?? "";
      if (text) handlers.onTextDelta?.(text);

      const scripted = next.toolCalls ?? (next.toolCall ? [next.toolCall] : []);
      const toolCalls = scripted.map((c) => ({ ...c, toolCallId: `tc-${++callCounter}` }));

      return { text, toolCalls };
    },
  };
}

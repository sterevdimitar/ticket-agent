import { config } from "../config.js";
import type { Message } from "../types.js";
import { geminiProvider } from "./geminiProvider.js";

export interface ToolCallProposal {
  toolCallId: string;
  /**
   * The provider reports faithfully what the model proposed, hallucinated names
   * included — deciding which names are known tools is loop policy, and the loop
   * must see the raw attempt in order to log it.
   */
  toolName: string;
  args: unknown;
}

export interface ModelStep {
  text: string;
  toolCalls: ToolCallProposal[];
}

export interface StepHandlers {
  onTextDelta?: (t: string) => void;
}

export interface ModelProvider {
  step(messages: Message[], handlers: StepHandlers): Promise<ModelStep>;
}

/** Test-only seam: install a scripted provider so tests can play a hostile model. */
let installed: ModelProvider | undefined;
export function setProvider(p: ModelProvider | undefined): void {
  installed = p;
}

export function getProvider(): ModelProvider {
  if (installed) return installed;
  if (config.modelProvider === "gemini") return geminiProvider;
  throw new Error(
    "No live model configured. MODEL_PROVIDER=fake is the scripted test model and needs a " +
      "script installed via setProvider(). To chat for real, set MODEL_PROVIDER=gemini and " +
      "GOOGLE_GENERATIVE_AI_API_KEY in .env (see .env.example), then restart.",
  );
}

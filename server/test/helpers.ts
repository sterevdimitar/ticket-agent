import type { ScriptedStep } from "../src/agent/fakeModel.js";
import { scriptedProvider } from "../src/agent/fakeModel.js";
import { setProvider } from "../src/agent/provider.js";
import { resetApprovals, setNow } from "../src/approvals/registry.js";
import { app } from "../src/index.js";
import { all, reset as resetLog } from "../src/log/invocationLog.js";
import { resetSessions } from "../src/store/sessionStore.js";
import { resetTickets } from "../src/store/ticketStore.js";
import type { InvocationLogEntry } from "../src/types.js";

export type SseFrame = { type: string; data: any };

export function resetWorld(): void {
  resetTickets();
  resetSessions();
  resetApprovals();
  resetLog();
  setProvider(undefined);
  setNow(Date.now);
}

/** Installs a fully scripted (i.e. arbitrarily hostile) model for the next turn. */
export function playModel(script: ScriptedStep[]): void {
  setProvider(scriptedProvider(script));
}

export function parseSse(body: string): SseFrame[] {
  return body
    .split("\n\n")
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => {
      const type = /^event:\s*(.+)$/m.exec(block)?.[1]?.trim() ?? "message";
      const raw = /^data:\s*(.*)$/m.exec(block)?.[1] ?? "{}";
      return { type, data: JSON.parse(raw) };
    });
}

export async function postChat(
  tenantId: string,
  sessionId: string,
  text: string,
): Promise<{ status: number; frames: SseFrame[]; body: string }> {
  const res = await app.request("/chat", {
    method: "POST",
    headers: { "content-type": "application/json", "X-Tenant-ID": tenantId },
    body: JSON.stringify({ sessionId, text }),
  });
  const body = await res.text();
  return {
    status: res.status,
    body,
    frames: res.status === 200 ? parseSse(body) : [],
  };
}

export async function postApproval(
  tenantId: string,
  sessionId: string,
  approvalId: string,
  approved: boolean,
): Promise<{ status: number; frames: SseFrame[]; body: string }> {
  const res = await app.request(`/approvals/${approvalId}`, {
    method: "POST",
    headers: { "content-type": "application/json", "X-Tenant-ID": tenantId },
    body: JSON.stringify({ sessionId, approved }),
  });
  const body = await res.text();
  return {
    status: res.status,
    body,
    frames: res.status === 200 ? parseSse(body) : [],
  };
}

export function mutateLog(): readonly InvocationLogEntry[] {
  return all().filter((e) => e.tool === "mutate_ticket");
}

export function executedMutations(): readonly InvocationLogEntry[] {
  return mutateLog().filter((e) => e.outcome === "executed");
}

import type { Session } from "../types.js";

const sessions = new Map<string, Session>();
const turnsInFlight = new Set<string>();

export function resetSessions(): void {
  sessions.clear();
  turnsInFlight.clear();
}

export type GetOrCreateResult =
  | { ok: true; session: Session }
  | { ok: false; reason: "tenant_mismatch" };

/**
 * A session is bound to the tenant that created it. A later request presenting a
 * different tenant for the same id is rejected rather than served — the client is
 * untrusted, and the session id is the only thing it carries.
 */
export function getOrCreateSession(sessionId: string, tenantId: string): GetOrCreateResult {
  const existing = sessions.get(sessionId);
  if (existing) {
    if (existing.tenantId !== tenantId) return { ok: false, reason: "tenant_mismatch" };
    return { ok: true, session: existing };
  }
  const session: Session = {
    sessionId,
    tenantId,
    messages: [],
    createdAt: new Date().toISOString(),
  };
  sessions.set(sessionId, session);
  return { ok: true, session };
}

export function getSession(sessionId: string): Session | undefined {
  return sessions.get(sessionId);
}

/**
 * One turn at a time per session. Two requests racing on the same id would hold
 * the same `Session` object and interleave two turns' messages into one history;
 * the browser tab that only ever sends one at a time is convenience, not control.
 * Returns false when a turn is already running — the caller answers 409 and
 * leaves the session alone.
 */
export function beginTurn(sessionId: string): boolean {
  if (turnsInFlight.has(sessionId)) return false;
  turnsInFlight.add(sessionId);
  return true;
}

export function endTurn(sessionId: string): void {
  turnsInFlight.delete(sessionId);
}

/**
 * A mutate proposal pauses the turn on a tool call only the approval endpoint may
 * answer. Anything appended before that result lands corrupts the history for good
 * — the provider rejects it, and the later approval fills the result in out of
 * position — so `/chat` has to see the pause for itself rather than trust the UI
 * to keep its modal up.
 */
export function hasUnansweredToolCall(session: Session): boolean {
  const proposed = new Set<string>();
  const answered = new Set<string>();
  for (const message of session.messages) {
    if (!Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (part.type === "tool-call") proposed.add(part.toolCallId);
      else if (part.type === "tool-result") answered.add(part.toolCallId);
    }
  }
  for (const id of proposed) if (!answered.has(id)) return true;
  return false;
}

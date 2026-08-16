import { Hono } from "hono";
import { systemPrompt } from "../agent/prompt.js";
import {
  beginTurn,
  getOrCreateSession,
  hasUnansweredToolCall,
} from "../store/sessionStore.js";
import type { TenantEnv } from "../tenant/middleware.js";
import { streamTurn } from "./turnStream.js";

export const chatRoute = new Hono<TenantEnv>();

/**
 * The client sends only `{sessionId, text}` plus its tenant header. History,
 * tool results and approval state are server-held and never accepted from it.
 */
chatRoute.post("/chat", async (c) => {
  const body = (await c.req.json().catch(() => null)) as unknown;
  if (
    !body ||
    typeof body !== "object" ||
    typeof (body as { sessionId?: unknown }).sessionId !== "string" ||
    typeof (body as { text?: unknown }).text !== "string"
  ) {
    return c.json({ error: "invalid_body" }, 400);
  }
  const { sessionId, text } = body as { sessionId: string; text: string };
  const tenantId = c.get("tenantId");

  const result = getOrCreateSession(sessionId, tenantId);
  if (!result.ok) return c.json({ error: "tenant_mismatch" }, 403);

  const session = result.session;

  // Both refusals happen before a single byte is written to the session: a client
  // that ignores its own modal, or fires two turns at once, gets 409 and an
  // untouched history rather than one the provider will reject forever after.
  if (hasUnansweredToolCall(session)) return c.json({ error: "approval_pending" }, 409);
  if (!beginTurn(session.sessionId)) return c.json({ error: "turn_in_progress" }, 409);

  if (session.messages.length === 0) {
    session.messages.push({ role: "system", content: systemPrompt() });
  }
  session.messages.push({ role: "user", content: text });

  return streamTurn(c, session, tenantId);
});

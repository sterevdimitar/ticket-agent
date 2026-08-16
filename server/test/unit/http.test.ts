import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { scriptedProvider } from "../../src/agent/fakeModel.js";
import { setProvider } from "../../src/agent/provider.js";
import { resetApprovals } from "../../src/approvals/registry.js";
import { app } from "../../src/index.js";
import { reset as resetLog } from "../../src/log/invocationLog.js";
import { sseEvent } from "../../src/http/sse.js";
import { resetSessions } from "../../src/store/sessionStore.js";
import { resetTickets } from "../../src/store/ticketStore.js";

describe("sseEvent", () => {
  it("formats an event frame", () => {
    expect(sseEvent("text-delta", { text: "hi" })).toBe(
      'event: text-delta\ndata: {"text":"hi"}\n\n',
    );
  });
});

describe("tenant middleware", () => {
  beforeEach(() => {
    resetTickets();
    resetSessions();
    resetApprovals();
    resetLog();
    setProvider(scriptedProvider([{ text: "ok" }]));
  });
  afterEach(() => {
    setProvider(undefined);
  });

  it("rejects a request with no tenant header", async () => {
    const res = await app.request("/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: "s1", text: "hi" }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "unknown_tenant" });
  });

  it("rejects an unknown tenant rather than defaulting", async () => {
    const res = await app.request("/chat", {
      method: "POST",
      headers: { "content-type": "application/json", "X-Tenant-ID": "tenant-zzz" },
      body: JSON.stringify({ sessionId: "s1", text: "hi" }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects a session presented under a second tenant with 403", async () => {
    const ok = await app.request("/chat", {
      method: "POST",
      headers: { "content-type": "application/json", "X-Tenant-ID": "tenant-a" },
      body: JSON.stringify({ sessionId: "shared", text: "hi" }),
    });
    expect(ok.status).toBe(200);
    await ok.text();

    setProvider(scriptedProvider([{ text: "ok" }]));
    const res = await app.request("/chat", {
      method: "POST",
      headers: { "content-type": "application/json", "X-Tenant-ID": "tenant-b" },
      body: JSON.stringify({ sessionId: "shared", text: "hi" }),
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "tenant_mismatch" });
  });

  it("rejects a malformed body", async () => {
    const res = await app.request("/chat", {
      method: "POST",
      headers: { "content-type": "application/json", "X-Tenant-ID": "tenant-a" },
      body: JSON.stringify({ text: "hi" }),
    });
    expect(res.status).toBe(400);
  });
});

import { beforeEach, describe, expect, it } from "vitest";
import {
  getOrCreateSession,
  getSession,
  resetSessions,
} from "../../src/store/sessionStore.js";

describe("sessionStore tenant binding", () => {
  beforeEach(() => {
    resetSessions();
  });

  it("creates a session bound to the first tenant that uses the id", () => {
    const r = getOrCreateSession("s1", "tenant-a");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.session.tenantId).toBe("tenant-a");
    expect(r.session.messages).toEqual([]);
  });

  it("returns the same session object on a repeat call from the same tenant", () => {
    const first = getOrCreateSession("s1", "tenant-a");
    const second = getOrCreateSession("s1", "tenant-a");
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.session).toBe(first.session);
  });

  it("rejects a later request that presents a different tenant for the same session", () => {
    getOrCreateSession("s1", "tenant-a");
    const r = getOrCreateSession("s1", "tenant-b");
    expect(r).toEqual({ ok: false, reason: "tenant_mismatch" });
  });

  it("does not create a session when the tenant mismatches", () => {
    getOrCreateSession("s1", "tenant-a");
    getOrCreateSession("s1", "tenant-b");
    expect(getSession("s1")?.tenantId).toBe("tenant-a");
  });

  it("getSession returns undefined for an unknown id", () => {
    expect(getSession("nope")).toBeUndefined();
  });
});

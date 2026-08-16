import type { MiddlewareHandler } from "hono";
import { isKnownTenant } from "../config.js";

export type TenantEnv = { Variables: { tenantId: string } };

/**
 * The fake-auth boundary. Missing or unknown tenant is a hard 400 — there is
 * deliberately no default tenant to fall back to.
 */
export const tenantMiddleware: MiddlewareHandler<TenantEnv> = async (c, next) => {
  const claimed = c.req.header("X-Tenant-ID");
  if (!isKnownTenant(claimed)) {
    return c.json({ error: "unknown_tenant" }, 400);
  }
  c.set("tenantId", claimed);
  await next();
};

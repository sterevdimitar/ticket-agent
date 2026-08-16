import { serveStatic } from "@hono/node-server/serve-static";
import { existsSync } from "node:fs";
import { relative } from "node:path";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { config } from "./config.js";
import { approvalsRoute, expireLapsedApprovals } from "./http/approvals.js";
import { chatRoute } from "./http/chat.js";
import { tenantMiddleware } from "./tenant/middleware.js";
import type { TenantEnv } from "./tenant/middleware.js";

export const app = new Hono<TenantEnv>();

app.use("/chat", tenantMiddleware);
app.use("/approvals/*", tenantMiddleware);

app.route("/", chatRoute);
app.route("/", approvalsRoute);

// Production: one process serves the built SPA and the API.
// serveStatic resolves `root` against the process CWD, so derive it from this
// module's location instead of assuming where `node` was launched from.
const webDist = fileURLToPath(new URL("../../web/dist", import.meta.url));
const staticRoot = (relative(process.cwd(), webDist) || ".").replaceAll("\\", "/");

// In dev the UI is served by Vite on :5173, so web/dist does not exist and mounting
// serveStatic against it only produces a misleading "root path not found" warning at
// startup. Mount it only once there is a build to serve.
if (existsSync(webDist)) {
  app.use("/*", serveStatic({ root: staticRoot }));
  app.get("*", serveStatic({ path: `${staticRoot}/index.html` }));
}

if (process.env.NODE_ENV !== "test" && process.env.VITEST === undefined) {
  // A decision arriving before the tick still discovers expiry itself in
  // claimPending; this timer exists only for approvals nobody ever decides.
  // unref() so a pending interval never holds the process open on its own.
  setInterval(expireLapsedApprovals, config.approvalSweepMs).unref();

  const { serve } = await import("@hono/node-server");
  serve({ fetch: app.fetch, port: config.serverPort }, (info) => {
    console.log(`ticket-agent server listening on http://localhost:${info.port}`);
    console.log(`model provider: ${config.modelProvider}`);
    if (config.modelProvider === "gemini" && !config.googleApiKey) {
      console.warn("warning: MODEL_PROVIDER=gemini but GOOGLE_GENERATIVE_AI_API_KEY is unset");
    }
    if (config.modelProvider === "fake") {
      console.warn(
        "warning: MODEL_PROVIDER=fake — chat requests will fail. Set MODEL_PROVIDER=gemini " +
          "in .env for a live model; 'fake' exists for the deterministic tests.",
      );
    }
  });
}

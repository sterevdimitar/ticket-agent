import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

export type ModelProviderName = "gemini" | "fake";

// Repo-root .env, resolved from this module so it loads the same from `npm run
// dev` (server/src) and `npm start` (server/dist). Real env vars still win.
const envFile = fileURLToPath(new URL("../../.env", import.meta.url));
if (existsSync(envFile)) {
  try {
    process.loadEnvFile(envFile);
  } catch {
    // A malformed .env should not stop the server from booting.
  }
}

const PROVIDERS: readonly ModelProviderName[] = ["gemini", "fake"];

/**
 * Normalizes casing and whitespace, but rejects anything unrecognized outright.
 * Silently falling back to "fake" on a typo produces the worst failure mode there
 * is here: a .env that looks correct while every chat request reports no model,
 * sending you off to debug an API key that was never the problem.
 */
export function parseModelProvider(raw: string | undefined): ModelProviderName {
  const value = (raw ?? "").trim().toLowerCase();
  if (value === "") return "fake";
  if ((PROVIDERS as readonly string[]).includes(value)) return value as ModelProviderName;
  throw new Error(
    `Invalid MODEL_PROVIDER: ${JSON.stringify(raw)}. Expected one of: ${PROVIDERS.join(", ")}. ` +
      "Check your .env file.",
  );
}

export const config = {
  serverPort: Number(process.env.PORT ?? 3000),
  /** Upper bound on model steps per turn — bounds the blast radius of a steered model. */
  stepCap: 8,
  approvalTtlMs: 120_000,
  /** How often the timer sweeps abandoned approvals — sets the worst-case delay
   *  (on top of approvalTtlMs) before a nobody-ever-decided approval is expired. */
  approvalSweepMs: 60_000,
  snippetMax: 200,
  searchResultCap: 10,
  tenants: ["tenant-a", "tenant-b"] as const,
  modelProvider: parseModelProvider(process.env.MODEL_PROVIDER),
  googleApiKey: process.env.GOOGLE_GENERATIVE_AI_API_KEY ?? "",
  /**
   * Defaults to the moving "latest flash" alias rather than a pinned version:
   * Google retires specific model ids for new API keys, and a pinned id turns
   * into a hard failure for anyone setting this up later. Override with
   * GEMINI_MODEL to pin a specific version.
   */
  geminiModel: process.env.GEMINI_MODEL?.trim() || "gemini-flash-latest",
};

export type TenantId = (typeof config.tenants)[number];

export function isKnownTenant(value: unknown): value is TenantId {
  return typeof value === "string" && (config.tenants as readonly string[]).includes(value);
}

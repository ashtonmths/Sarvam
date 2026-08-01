import { z } from "zod";

/**
 * The only module in the API that reads `process.env`. Boot-required values
 * are validated here and the process exits naming the exact variable; the
 * feature-gated groups stay optional so the API boots — and the deterministic
 * verdict path keeps working — with nothing but Postgres configured.
 */

const Env = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3001),

  // boot-required
  DATABASE_URL: z.string().url(),

  // auth (plan 4) — a dev default keeps `pnpm dev` zero-config; production
  // must set it, which the check below enforces.
  SESSION_SECRET: z.string().min(16).default("dev-only-insecure-session-secret"),
  WEB_ORIGIN: z.string().url().default("http://localhost:3000"),

  // credential vault (plan 5). Absent ⇒ credential storage reports itself
  // unavailable; crawls against already-stored credentials still work.
  CREDENTIAL_MASTER_KEY: z.string().min(1).optional(),
  CREDENTIAL_MASTER_KEY_PREVIOUS: z.string().min(1).optional(),

  // jobs (plan 3)
  JOBS_ENABLED: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
  JOBS_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(4),
  JOBS_POLL_MS: z.coerce.number().int().min(200).max(60_000).default(2_000),
  JOBS_DRAIN_TIMEOUT_MS: z.coerce.number().int().min(1_000).default(45_000),

  // pools (plan 3)
  PG_POOL_WEB: z.coerce.number().int().min(1).max(50).default(10),
  PG_POOL_JOBS: z.coerce.number().int().min(1).max(50).default(5),

  // feature-gated: absent ⇒ the feature reports itself unavailable
  OPENROUTER_API_KEY: z.string().min(1).optional(),
  OPENROUTER_MODEL_STRONG: z.string().min(1).optional(),
  OPENROUTER_MODEL_BULK: z.string().min(1).optional(),

  // dev-seed connector credentials only — real orgs use the vault
  N8N_BASE_URL: z.string().url().optional(),
  N8N_API_KEY: z.string().min(1).optional(),
  AIRTABLE_TOKEN: z.string().min(1).optional(),
  GITHUB_TOKEN: z.string().min(1).optional(),
  SLACK_BOT_TOKEN: z.string().min(1).optional(),
});

const parsed = Env.safeParse(process.env);
if (!parsed.success) {
  console.error("Invalid environment:", parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const config = parsed.data;

if (config.NODE_ENV === "production" && config.SESSION_SECRET.startsWith("dev-only")) {
  console.error("Invalid environment: SESSION_SECRET must be set in production");
  process.exit(1);
}

export type Config = typeof config;

/**
 * For feature-gated groups: throws naming the variable at the call site, so a
 * missing key fails the feature rather than the boot.
 */
export function requireEnv<K extends keyof Config>(key: K): NonNullable<Config[K]> {
  const value = config[key];
  if (value === undefined || value === null || value === "") {
    throw new Error(`${String(key)} is not configured`);
  }
  return value as NonNullable<Config[K]>;
}

export const isProd = config.NODE_ENV === "production";

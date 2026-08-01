import { existsSync } from "node:fs";
import { z } from "zod";

/**
 * The only module in the API that reads `process.env`. Boot-required values
 * are validated here and the process exits naming the exact variable; the
 * feature-gated groups stay optional so the API boots — and the deterministic
 * verdict path keeps working — with nothing but Postgres configured.
 */

/**
 * Load `.env` for local development. In a container the environment is
 * already populated and there is no file, so this is a no-op — which is why
 * it is a silent try rather than a hard requirement.
 *
 * Real values already in the environment win: `DATABASE_URL=… pnpm seed`
 * must override the file, not the other way round.
 */
function loadDotEnv(): void {
  for (const candidate of [".env", "../../.env"]) {
    if (!existsSync(candidate)) continue;
    try {
      const before = new Set(Object.keys(process.env));
      process.loadEnvFile(candidate);
      // process.loadEnvFile overwrites, so restore anything that was already
      // set explicitly by the caller.
      for (const key of before) {
        const original = originalEnv.get(key);
        if (original !== undefined) process.env[key] = original;
      }
      return;
    } catch {
      /* malformed or unreadable .env falls through to schema validation */
    }
  }
}

const originalEnv = new Map(Object.entries(process.env) as Array<[string, string]>);
loadDotEnv();

const Env = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  /** Raise to `debug` while chasing something; `silent` only in tests. */
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
    .default("info"),
  /**
   * Bearer token for `GET /metrics`. Absent ⇒ the endpoint 404s, because the
   * API is internet-facing and traffic volumes, org counts and per-caller
   * limit rejections are not things to publish to anyone who asks.
   */
  METRICS_TOKEN: z.string().min(16).optional(),
  /**
   * OTLP collector base URL, e.g. `http://tempo:4318`. Absent ⇒ the tracing
   * SDK never starts and every span is a no-op, rather than batching into a
   * socket nobody is holding.
   */
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().url().optional(),

  /**
   * Where the Historian's Slack tools point. Defaults to the real API; the
   * agent evals override it to a local fixture server serving planted
   * evidence, which is the only way to score judgment against a known answer
   * without a live workspace.
   */
  SLACK_API_BASE_URL: z.string().url().default("https://slack.com/api"),

  /**
   * Resend API key. Absent ⇒ every send is recorded as skipped and nothing
   * leaves, in the same spirit as the tracing and error-reporting keys. A
   * lifecycle email that threw on a machine with no provider would take down
   * the crawl that triggered it, and the crawl matters more.
   */
  RESEND_API_KEY: z.string().optional(),

  /** The From address. Only meaningful when a provider is configured. */
  MAIL_FROM: z.string().default("Sadhak <hello@sadhak.online>"),

  /**
   * Sentry DSN. Absent ⇒ the SDK never initializes and every capture is a
   * no-op. Errors only; Tempo owns tracing.
   */
  SENTRY_DSN: z.string().url().optional(),

  /**
   * The image's commit sha, baked in at build time. Absent in dev, where the
   * running code is whatever is on disk and no sha would describe it honestly.
   * Tags log lines and trace spans, so "which build produced this" is
   * answerable from a single line rather than by matching timestamps against a
   * deploy log.
   */
  GIT_SHA: z.string().optional(),

  // boot-required
  DATABASE_URL: z.string().url(),

  // auth (plan 4) — a dev default keeps `pnpm dev` zero-config; production
  // must set it, which the check below enforces.
  SESSION_SECRET: z.string().min(16).default("dev-only-insecure-session-secret"),
  /**
   * Comma-separated CORS allowlist. A list rather than one value because the
   * apex and `www.` are different origins to a browser, and a self-host may
   * front the web app on its own domain. Every entry is parsed as a URL and
   * reduced to scheme+host+port, so a trailing path or slash cannot silently
   * produce an origin that never matches.
   */
  WEB_ORIGINS: z
    .string()
    .default("http://localhost:3000")
    .transform((raw, ctx) => {
      const origins = raw
        .split(",")
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0)
        .map((entry) => {
          try {
            return new URL(entry).origin;
          } catch {
            ctx.addIssue({ code: z.ZodIssueCode.custom, message: `not a URL: ${entry}` });
            return entry;
          }
        });
      if (origins.length === 0) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "must list one origin" });
      }
      return origins;
    }),

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
  /**
   * How long to keep serving after readiness flips to 503, so the proxy has
   * time to notice and stop routing. Must exceed two of its health intervals
   * or a redeploy drops the requests still in flight toward us.
   */
  DRAIN_DELAY_MS: z.coerce.number().int().min(0).max(30_000).default(8_000),

  // pools (plan 3)
  PG_POOL_WEB: z.coerce.number().int().min(1).max(50).default(10),
  PG_POOL_JOBS: z.coerce.number().int().min(1).max(50).default(5),

  // rate limits (plan 13). Per minute, fixed window. The kill switch exists
  // because a limiter misfiring during an incident must be one env var away
  // from off, not one deploy away.
  RATE_LIMIT_ENABLED: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
  /** Unauthenticated, per replica. Protects this process from a flood. */
  RATE_LIMIT_IP_PER_MIN: z.coerce.number().int().min(1).default(60),
  /** Credential stuffing costs more than browsing does. */
  RATE_LIMIT_AUTH_PER_MIN: z.coerce.number().int().min(1).default(10),
  RATE_LIMIT_KEY_PER_MIN: z.coerce.number().int().min(1).default(300),
  RATE_LIMIT_ORG_PER_MIN: z.coerce.number().int().min(1).default(1200),
  RATE_LIMIT_WEBHOOK_PER_MIN: z.coerce.number().int().min(1).default(300),

  /**
   * Hostnames the egress guard may reach despite resolving privately.
   * Operator-set: the prod stack crawls its own bundled n8n over the compose
   * network. Never reachable from org-level config, or a tenant could
   * allowlist their way to the metadata endpoint.
   */
  EGRESS_ALLOW_PRIVATE_HOSTS: z
    .string()
    .default("n8n")
    .transform((raw) =>
      raw
        .split(",")
        .map((host) => host.trim().toLowerCase())
        .filter((host) => host.length > 0),
    ),

  // feature-gated: absent ⇒ the feature reports itself unavailable
  OPENROUTER_API_KEY: z.string().min(1).optional(),
  OPENROUTER_MODEL_STRONG: z.string().min(1).optional(),
  OPENROUTER_MODEL_BULK: z.string().min(1).optional(),

  // models (plans 7 and 10). The kill switch is the drill lever and the
  // incident lever; the quotas are hard product constraints, not footnotes.
  LLM_DISABLED: z
    .enum(["0", "1", "true", "false"])
    .default("0")
    .transform((v) => v === "1" || v === "true"),
  /** Account-wide, not per model or per process. */
  LLM_RPM_LIMIT: z.coerce.number().int().min(1).max(1000).default(20),
  /** 50 on a bare free account; 1000 after the one-time $10 credit. */
  LLM_DAILY_REQUEST_CAP: z.coerce.number().int().min(1).default(1000),

  // historian (plan 10)
  HISTORIAN_STEP_BUDGET: z.coerce.number().int().min(1).max(50).default(10),
  HISTORIAN_MAX_PARSE_FAILURES: z.coerce.number().int().min(1).max(10).default(2),
  HISTORIAN_FANOUT_MAX_EDGES: z.coerce.number().int().min(1).max(200).default(25),
  HISTORIAN_FANOUT_CONCURRENCY_MAX: z.coerce.number().int().min(1).max(32).default(5),
  HISTORIAN_EXPECTED_CALLS_PER_LOOP: z.coerce.number().int().min(1).max(50).default(5),
  HISTORIAN_MAX_QUEUED_PER_ORG: z.coerce.number().int().min(1).default(50),
  HISTORIAN_ORG_BUDGET_USD: z.coerce.number().min(0).default(20),
  /** Stops one org draining the shared account for every other org. */
  HISTORIAN_ORG_DAILY_REQUESTS: z.coerce.number().int().min(1).default(600),
  SLACK_SCAN_MESSAGES: z.coerce.number().int().min(1).max(20_000).default(2000),

  // github app (plan 8) — platform secrets, not tenant secrets
  GITHUB_APP_ID: z.string().min(1).optional(),
  GITHUB_APP_PRIVATE_KEY: z.string().min(1).optional(),
  GITHUB_APP_WEBHOOK_SECRET: z.string().min(1).optional(),

  // slack app (plan 9)
  SLACK_CLIENT_ID: z.string().min(1).optional(),
  SLACK_CLIENT_SECRET: z.string().min(1).optional(),
  SLACK_SIGNING_SECRET: z.string().min(1).optional(),

  // dev-seed connector credentials only — real orgs use the vault
  N8N_BASE_URL: z.string().url().optional(),
  N8N_API_KEY: z.string().min(1).optional(),
  AIRTABLE_TOKEN: z.string().min(1).optional(),
  GITHUB_TOKEN: z.string().min(1).optional(),
  SLACK_BOT_TOKEN: z.string().min(1).optional(),
});

/**
 * A blank line in `.env` means "not set", not "set to the empty string".
 * `.env.example` ships every optional variable with an empty value so the file
 * documents itself, so this is the difference between a working copy-paste
 * setup and a boot failure listing six variables the user deliberately left
 * blank.
 */
const withoutBlanks = Object.fromEntries(
  Object.entries(process.env).filter(([, value]) => value !== ""),
);

const parsed = Env.safeParse(withoutBlanks);
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

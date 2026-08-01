import type { Context, MiddlewareHandler } from "hono";
import { config } from "../config.js";
import { sql } from "../db.js";
import { RateLimitedError } from "../errors.js";
import { rateLimitDecisions } from "../metrics.js";
import { clientIp } from "./client-ip.js";

/**
 * Fixed-window rate limiting in three tiers.
 *
 * Fixed windows, not sliding: a sliding window needs either a sorted set per
 * caller or a second round trip, and the failure mode it fixes (up to 2x the
 * limit across a window boundary) is one we can absorb. One UPSERT per
 * request is the budget.
 *
 * Where each tier's counter lives is a deliberate split:
 *   - per-IP is in-process, because it defends *this replica* against
 *     unauthenticated floods and must not cost a database round trip to say no
 *     to traffic that has not authenticated yet.
 *   - per-key and per-org are in Postgres, because they are budgets we quote
 *     to customers, and a budget counted separately by each replica is
 *     silently N times the number in the docs.
 *
 * Scaling note: the per-IP tier is correct at one API replica. If the stack
 * ever runs more than one, that tier either moves into `rate_counters` or
 * accepts N x the limit. It is called out here rather than in a runbook
 * because this comment is what someone actually reads when they add a replica.
 */

const WINDOW_MS = 60_000;

export interface LimitDecision {
  allowed: boolean;
  /** Seconds until the current window rolls over. */
  retryAfterSeconds: number;
}

/** Start of the window containing `now`, in epoch milliseconds. */
function windowStartMs(now: number): number {
  return Math.floor(now / WINDOW_MS) * WINDOW_MS;
}

function retryAfter(now: number): number {
  const elapsed = now % WINDOW_MS;
  return Math.max(1, Math.ceil((WINDOW_MS - elapsed) / 1000));
}

/* ----------------------------------------------------------- in-process */

interface MemoryWindow {
  windowStartMs: number;
  count: number;
}

const memoryBuckets = new Map<string, MemoryWindow>();

/**
 * Bounded by a sweep on write rather than a timer: an interval would keep the
 * event loop alive and has to be torn down in tests and on shutdown.
 */
function sweepMemory(nowWindow: number): void {
  if (memoryBuckets.size < 10_000) return;
  for (const [key, window] of memoryBuckets) {
    if (window.windowStartMs < nowWindow) memoryBuckets.delete(key);
  }
}

export function hitMemory(
  bucket: string,
  limit: number,
  now = Date.now(),
): LimitDecision {
  const startMs = windowStartMs(now);
  const existing = memoryBuckets.get(bucket);

  if (!existing || existing.windowStartMs !== startMs) {
    sweepMemory(startMs);
    memoryBuckets.set(bucket, { windowStartMs: startMs, count: 1 });
    return { allowed: 1 <= limit, retryAfterSeconds: retryAfter(now) };
  }

  existing.count += 1;
  return { allowed: existing.count <= limit, retryAfterSeconds: retryAfter(now) };
}

/** Test seam. Production never needs this; a fresh process starts empty. */
export function resetMemoryBuckets(): void {
  memoryBuckets.clear();
}

/* -------------------------------------------------------------- shared */

/**
 * One round trip: increment and read back in a single statement, so two
 * concurrent requests cannot both read a stale count and both decide they are
 * under the limit.
 */
export async function hitShared(
  bucket: string,
  limit: number,
  now = Date.now(),
): Promise<LimitDecision> {
  // Epoch seconds through `to_timestamp` rather than binding a Date: the
  // window boundary is then computed by Postgres from an unambiguous number,
  // with no dependence on how the driver infers a JavaScript Date's type.
  const rows = await sql<{ count: number }[]>`
    INSERT INTO rate_counters (bucket, window_start, count)
    VALUES (${bucket}, to_timestamp(${windowStartMs(now) / 1000}), 1)
    ON CONFLICT (bucket, window_start)
    DO UPDATE SET count = rate_counters.count + 1
    RETURNING count
  `;

  const count = rows[0]?.count ?? 1;
  return { allowed: count <= limit, retryAfterSeconds: retryAfter(now) };
}

/**
 * Windows older than an hour are dead weight. Called by the retention job
 * rather than on the request path.
 */
export async function purgeStaleCounters(): Promise<number> {
  const rows = await sql`
    DELETE FROM rate_counters WHERE window_start < now() - interval '1 hour'
  `;
  return rows.count;
}

/* --------------------------------------------------------- middleware */

/**
 * Dokploy's healthcheck must never be throttled: a limiter that answers 429
 * here takes the container out of rotation and turns a traffic spike into an
 * outage.
 */
function isExempt(c: Context): boolean {
  return c.req.path === "/health";
}

/**
 * Counted at every tier, allowed as well as limited. A sustained rise in
 * `limited` on the ip tier is a misconfigured client or someone probing, and
 * neither is legible without the allowed count next to it.
 */
function record(tier: string, decision: LimitDecision): void {
  rateLimitDecisions.inc({ tier, outcome: decision.allowed ? "allowed" : "limited" });
}

function deny(decision: LimitDecision): never {
  throw new RateLimitedError("Too many requests", decision.retryAfterSeconds);
}

/**
 * Per-IP, before authentication. Auth routes get the tighter budget because
 * that is where guessing a password is worth someone's time.
 */
export const ipRateLimit: MiddlewareHandler = async (c, next) => {
  if (!config.RATE_LIMIT_ENABLED || isExempt(c)) return next();

  const isAuthRoute = c.req.path.startsWith("/api/auth/");
  const limit = isAuthRoute
    ? config.RATE_LIMIT_AUTH_PER_MIN
    : config.RATE_LIMIT_IP_PER_MIN;
  const tier = isAuthRoute ? "auth" : "ip";

  const decision = hitMemory(`${tier}:${clientIp(c)}`, limit);
  record(tier, decision);
  if (!decision.allowed) deny(decision);
  await next();
};

/**
 * Per-key and per-org, after authentication. Both are charged: a single key
 * cannot exceed its own budget, and no combination of keys and sessions can
 * exceed the org's.
 */
export const identityRateLimit: MiddlewareHandler = async (c, next) => {
  if (!config.RATE_LIMIT_ENABLED || isExempt(c)) return next();

  const actor = c.get("actor");
  if (actor?.type === "api_key") {
    const decision = await hitShared(`key:${actor.id}`, config.RATE_LIMIT_KEY_PER_MIN);
    record("key", decision);
    if (!decision.allowed) deny(decision);
  }

  const orgId = c.get("orgId");
  if (orgId !== undefined) {
    const decision = await hitShared(`org:${orgId}`, config.RATE_LIMIT_ORG_PER_MIN);
    record("org", decision);
    if (!decision.allowed) deny(decision);
  }

  await next();
};

/**
 * Vendor ingress, keyed per instance. Delivery dedupe already makes provider
 * retries harmless, so this exists for a misconfigured or hostile sender
 * rather than for normal retry traffic.
 */
export const webhookRateLimit: MiddlewareHandler = async (c, next) => {
  if (!config.RATE_LIMIT_ENABLED) return next();

  // Everything after /webhooks/ identifies the sender well enough to bucket
  // it, and is a bounded path segment rather than caller-supplied text.
  const target = c.req.path.slice("/webhooks/".length) || "unknown";
  const decision = await hitShared(
    `webhook:${target}`,
    config.RATE_LIMIT_WEBHOOK_PER_MIN,
  );
  record("webhook", decision);
  if (!decision.allowed) deny(decision);
  await next();
};

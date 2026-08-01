import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { config } from "./config.js";
import { constantTimeEqual } from "./crypto/compare.js";
import { closePools } from "./db.js";
import { NotFoundError } from "./errors.js";
import { requestsRemainingToday } from "./historian/budget.js";
import { beginDraining, readiness } from "./http/health.js";
import { notFound, onError, requestId, requestLog } from "./http/middleware.js";
import { identityRateLimit, ipRateLimit, webhookRateLimit } from "./http/rate-limit.js";
import { bodyGuard, corsMiddleware, securityHeaders } from "./http/security.js";
import { registerJobHandlers, scheduleDueCrawls } from "./jobs/handlers.js";
import { queueStats } from "./jobs/queue.js";
import { startWorker, stopWorker } from "./jobs/worker.js";
import { requestsInCurrentWindow } from "./llm.js";
import { log } from "./log.js";
import {
  llmDailyQuotaRemaining,
  llmRpmWindowUsed,
  registerCollector,
  render,
} from "./metrics.js";
import { requireAuth, requireOrg } from "./middleware/auth.js";
import { authRoutes } from "./routes/auth.js";
import { connectorRoutes } from "./routes/connectors.js";
import { gateRoutes } from "./routes/gate.js";
import { githubRoutes } from "./routes/github.js";
import { graphRoutes } from "./routes/graph.js";
import { historianRoutes } from "./routes/historian.js";
import { mcpRoutes } from "./routes/mcp.js";
import { orgRoutes } from "./routes/org.js";
import { rationaleRoutes } from "./routes/rationale.js";
import { reflexRoutes } from "./routes/reflex.js";
import { reviewerRoutes } from "./routes/reviewer.js";
import { verdictRoutes } from "./routes/verdict.js";
import { webhookRoutes } from "./routes/webhooks.js";
import { startErrorTracking } from "./sentry.js";
import { startTracing } from "./tracing.js";

/**
 * Before anything it should instrument is constructed. An SDK started after
 * the server would trace nothing that happened during boot, which is exactly
 * the window a slow start needs explaining.
 */
startTracing();
startErrorTracking();

/**
 * Sampled from Postgres at scrape time, not incremented in process. The daily
 * cap is account-wide and this process is one of possibly several readers, so
 * a local counter would drift the moment a worker ran anywhere else.
 */
registerCollector(async () => {
  const remaining = await requestsRemainingToday();
  llmDailyQuotaRemaining.set(
    config.LLM_DAILY_REQUEST_CAP > 0 ? remaining / config.LLM_DAILY_REQUEST_CAP : 0,
  );
  llmRpmWindowUsed.set(
    config.LLM_RPM_LIMIT > 0 ? requestsInCurrentWindow() / config.LLM_RPM_LIMIT : 0,
  );
});

const app = new Hono();

// Headers first: a response rejected by any middleware below still carries
// its armor, including the error paths.
app.use("*", securityHeaders);
// Request id next, so every error and log line downstream carries it.
app.use("*", requestId);
// Then the access log, inside the id context and outside everything that can
// reject: a 413 or a 429 is exactly the request worth having a line for.
app.use("*", requestLog);
app.use("*", corsMiddleware);

// Webhook ingress buffers whole provider deliveries and gets a larger cap;
// everything else is held to the small one.
app.use("*", bodyGuard);

// Per-IP, before anything reads a credential: an unauthenticated flood must be
// refused without touching Postgres.
app.use("*", ipRateLimit);

app.onError(onError);
app.notFound(notFound);

/**
 * Liveness: process only, never the database. A Postgres blip must not get
 * every API container killed — restarting containers is exactly what does not
 * help a database under load.
 */
app.get("/healthz", (c) => c.json({ ok: true }));

/** Readiness: should traffic route here. 503 drains without killing. */
app.get("/readyz", async (c) => {
  const result = await readiness();
  return c.json(result, result.ready ? 200 : 503);
});

/**
 * Deprecated alias for `/readyz`, kept until the Dokploy and Traefik configs
 * move. Removing it before they do would silently mark the container unhealthy.
 */
app.get("/health", async (c) => {
  const result = await readiness();
  return c.json(
    { ok: result.ready, db: result.checks.db === "ok" ? "up" : "down" },
    result.ready ? 200 : 503,
  );
});

/**
 * Prometheus exposition. Behind a bearer token and 404 rather than 401 when no
 * token is configured, so an internet-facing deployment does not advertise that
 * the endpoint exists at all. Traffic volume, org counts and which callers are
 * hitting their limits are not public facts.
 */
app.get("/metrics", async (c) => {
  const expected = config.METRICS_TOKEN;
  if (!expected) throw new NotFoundError();

  const presented = c.req.header("authorization")?.replace(/^Bearer\s+/i, "");
  if (!presented || !constantTimeEqual(presented, expected)) {
    throw new NotFoundError();
  }

  return c.text(await render(), 200, { "Content-Type": "text/plain; version=0.0.4" });
});

// Unauthenticated by necessity: this is where sessions are created.
app.route("/api/auth", authRoutes);

// MCP carries its own API-key auth inside the JSON-RPC envelope, so it mounts
// outside the session group. The key's org scopes every query.
app.route("/", mcpRoutes);

// Vendor ingress: signature-verified, never cookie-authenticated.
app.use("/webhooks/*", webhookRateLimit);
app.route("/", webhookRoutes);

/**
 * Everything else mounts inside the authenticated, org-scoped group, so a
 * route cannot be born unscoped. Later plans add only their capability check.
 */
const api = new Hono();
api.use("*", requireAuth);
api.use("*", requireOrg);
// After auth: the key and org tiers need a resolved identity to charge.
api.use("*", identityRateLimit);
api.route("/", orgRoutes);
api.route("/", connectorRoutes);
api.route("/", graphRoutes);
api.route("/", verdictRoutes);
api.route("/", gateRoutes);
api.route("/", githubRoutes);
api.route("/", reflexRoutes);
api.route("/", reviewerRoutes);
api.route("/", rationaleRoutes);
api.route("/", historianRoutes);
api.get("/jobs/stats", async (c) => c.json(await queueStats()));

// Both shapes hit the same handlers; `:orgId` is asserted against the
// credential-resolved org by requireOrg and is never a lookup key.
app.route("/api", api);
app.route("/api/orgs/:orgId", api);

registerJobHandlers();

const isEntrypoint = process.argv[1]?.endsWith("index.ts");
if (isEntrypoint) {
  const server = serve({ fetch: app.fetch, port: config.PORT }, (info) => {
    log().info({ event: "api_started", port: info.port }, "sadhak api listening");
  });

  if (config.JOBS_ENABLED) {
    startWorker();
    void scheduleDueCrawls().catch(() => undefined);
  }

  /**
   * Ordered, because the order is the whole mechanism. Readiness flips first
   * so the proxy stops routing here, and only then does the socket close —
   * closing first would refuse requests the proxy was still sending, which
   * presents to a user as a failed deploy.
   *
   * The dead-man timer force-exits inside the compose stop_grace_period, so a
   * handler that will not finish costs a slow shutdown rather than a SIGKILL
   * mid-write.
   */
  const shutdown = async () => {
    log().info({ event: "shutdown_started" }, "draining: readiness now 503");
    beginDraining();

    const deadline = setTimeout(() => {
      log().error({ event: "shutdown_forced" }, "drain did not finish, exiting");
      process.exit(1);
    }, 55_000);
    deadline.unref();

    await new Promise((resolve) => setTimeout(resolve, config.DRAIN_DELAY_MS));

    server.close();
    await stopWorker();
    await closePools();
    log().info({ event: "shutdown_complete" });
    process.exit(0);
  };

  process.on("SIGTERM", () => void shutdown());
  process.on("SIGINT", () => void shutdown());
}

export { app };

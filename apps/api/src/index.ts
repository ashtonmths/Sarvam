import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { config } from "./config.js";
import { closePools, sql } from "./db.js";
import { notFound, onError, requestId } from "./http/middleware.js";
import { registerJobHandlers, scheduleDueCrawls } from "./jobs/handlers.js";
import { queueStats } from "./jobs/queue.js";
import { startWorker, stopWorker } from "./jobs/worker.js";
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
import { verdictRoutes } from "./routes/verdict.js";
import { webhookRoutes } from "./routes/webhooks.js";

const app = new Hono();

// Request id first, so every error and log line downstream carries it.
app.use("*", requestId);
app.use(
  "*",
  cors({
    origin: [config.WEB_ORIGIN],
    credentials: true,
    allowHeaders: ["content-type", "x-api-key", "authorization", "x-request-id"],
  }),
);

app.onError(onError);
app.notFound(notFound);

app.get("/health", async (c) => {
  try {
    await sql`SELECT 1`;
    return c.json({ ok: true, db: "up" });
  } catch {
    return c.json({ ok: false, db: "down" }, 503);
  }
});

// Unauthenticated by necessity: this is where sessions are created.
app.route("/api/auth", authRoutes);

// MCP carries its own API-key auth inside the JSON-RPC envelope, so it mounts
// outside the session group. The key's org scopes every query.
app.route("/", mcpRoutes);

// Vendor ingress: signature-verified, never cookie-authenticated.
app.route("/", webhookRoutes);

/**
 * Everything else mounts inside the authenticated, org-scoped group, so a
 * route cannot be born unscoped. Later plans add only their capability check.
 */
const api = new Hono();
api.use("*", requireAuth);
api.use("*", requireOrg);
api.route("/", orgRoutes);
api.route("/", connectorRoutes);
api.route("/", graphRoutes);
api.route("/", verdictRoutes);
api.route("/", gateRoutes);
api.route("/", githubRoutes);
api.route("/", reflexRoutes);
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
    console.log(`sadhak api listening on :${info.port}`);
  });

  if (config.JOBS_ENABLED) {
    startWorker();
    void scheduleDueCrawls().catch(() => undefined);
  }

  const shutdown = async () => {
    console.log("shutting down: draining jobs…");
    server.close();
    await stopWorker();
    await closePools();
    process.exit(0);
  };

  process.on("SIGTERM", () => void shutdown());
  process.on("SIGINT", () => void shutdown());
}

export { app };

import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { connectorInstances, githubInstallations } from "@sadhak/shared/schema";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { config } from "../config.js";
import { db } from "../db.js";
import { verifyWebhookSignature } from "../github/app.js";
import { enqueue } from "../jobs/queue.js";
import { handleSlackInteraction } from "../reflex/interactions.js";

/**
 * Vendor ingress. Outside the session group — vendors do not hold cookies —
 * and every route reads the **raw body before any parsing**, because
 * signatures are computed over exact bytes and acting on an unverified
 * payload is how a webhook route becomes a remote instruction to run our
 * revert machinery.
 *
 * Each handler does verify → dedupe → enqueue and nothing else. All real work
 * happens on the queue, so a burst of provider retries cannot take the API
 * down and every ack stays inside the vendor's timeout.
 */

export const webhookRoutes = new Hono();

/** Seen delivery ids, so a vendor retry is one job rather than two. */
const seenDeliveries = new Map<string, number>();

function alreadySeen(key: string): boolean {
  const now = Date.now();
  for (const [id, at] of seenDeliveries) {
    if (now - at > 30 * 60_000) seenDeliveries.delete(id);
  }
  if (seenDeliveries.has(key)) return true;
  seenDeliveries.set(key, now);
  return false;
}

/* ------------------------------------------------------------- GitHub */

webhookRoutes.post("/webhooks/github", async (c) => {
  const raw = await c.req.text();
  const signature = c.req.header("x-hub-signature-256");

  if (!verifyWebhookSignature(raw, signature)) {
    // Never reveal whether the secret or the payload was wrong.
    return c.json({ ok: false }, 401);
  }

  const delivery =
    c.req.header("x-github-delivery") ?? createHash("sha256").update(raw).digest("hex");
  if (alreadySeen(`github:${delivery}`)) return c.json({ ok: true, duplicate: true });

  const event = c.req.header("x-github-event") ?? "";
  const payload = JSON.parse(raw) as GithubPayload;

  switch (event) {
    case "installation":
    case "installation_repositories":
      await handleInstallation(payload);
      return c.json({ ok: true });

    case "pull_request": {
      const action = payload.action ?? "";
      if (!["opened", "synchronize", "reopened"].includes(action)) {
        return c.json({ ok: true, ignored: action });
      }
      await enqueueCheck(payload);
      return c.json({ ok: true });
    }

    case "check_run":
    case "check_suite": {
      // The re-run button: same head SHA, fresh evaluation.
      if (payload.action !== "rerequested") return c.json({ ok: true });
      await enqueueCheck(payload);
      return c.json({ ok: true });
    }

    default:
      return c.json({ ok: true, ignored: event });
  }
});

interface GithubPayload {
  action?: string;
  installation?: {
    id: number;
    account?: { login?: string };
    repository_selection?: string;
  };
  repository?: { full_name?: string };
  pull_request?: {
    number: number;
    head?: { sha?: string };
    base?: { sha?: string };
  };
  check_run?: {
    check_suite?: { head_sha?: string; pull_requests?: Array<{ number: number }> };
  };
  check_suite?: { head_sha?: string; pull_requests?: Array<{ number: number }> };
}

async function handleInstallation(payload: GithubPayload): Promise<void> {
  const installationId = payload.installation?.id;
  if (!installationId) return;

  if (payload.action === "deleted") {
    // Tombstone rather than delete: a decision from an uninstalled org must be
    // impossible, and the history of having been installed is worth keeping.
    await db
      .update(githubInstallations)
      .set({ removedAt: new Date() })
      .where(eq(githubInstallations.installationId, installationId));
    return;
  }

  await db
    .insert(githubInstallations)
    .values({
      installationId,
      accountLogin: payload.installation?.account?.login ?? null,
      repositorySelection: payload.installation?.repository_selection ?? null,
      ...(payload.action === "suspend" ? { suspendedAt: new Date() } : {}),
    })
    .onConflictDoUpdate({
      target: githubInstallations.installationId,
      set: {
        accountLogin: payload.installation?.account?.login ?? null,
        repositorySelection: payload.installation?.repository_selection ?? null,
        removedAt: null,
        suspendedAt: payload.action === "suspend" ? new Date() : null,
      },
    });
}

async function enqueueCheck(payload: GithubPayload): Promise<void> {
  const installationId = payload.installation?.id;
  const repo = payload.repository?.full_name;
  if (!installationId || !repo) return;

  const pr =
    payload.pull_request ??
    (payload.check_run?.check_suite?.pull_requests?.[0]
      ? {
          number: payload.check_run.check_suite.pull_requests[0].number,
          head: { sha: payload.check_run.check_suite.head_sha },
        }
      : payload.check_suite?.pull_requests?.[0]
        ? {
            number: payload.check_suite.pull_requests[0].number,
            head: { sha: payload.check_suite.head_sha },
          }
        : undefined);

  const headSha = pr?.head?.sha;
  if (!pr || !headSha) return;

  await enqueue(
    "github.check",
    {
      installationId,
      repo,
      prNumber: pr.number,
      headSha,
      baseSha: pr.base?.sha ?? "",
    },
    // One check per head SHA: a re-push supersedes, a retry does not double.
    { dedupeKey: `github.check:${repo}:${headSha}`, priority: 7 },
  );
}

/* -------------------------------------------------------------- Slack */

webhookRoutes.post("/webhooks/slack/interactions", async (c) => {
  const raw = await c.req.text();
  const timestamp = c.req.header("x-slack-request-timestamp") ?? "";
  const signature = c.req.header("x-slack-signature") ?? "";

  if (!verifySlack(raw, timestamp, signature)) return c.json({ ok: false }, 401);

  // Ack inside Slack's 3-second deadline, then do the real work on the queue.
  const params = new URLSearchParams(raw);
  const payloadRaw = params.get("payload");
  if (payloadRaw) {
    void handleSlackInteraction(JSON.parse(payloadRaw) as Record<string, unknown>).catch(
      () => undefined,
    );
  }
  return c.body(null, 200);
});

function verifySlack(raw: string, timestamp: string, signature: string): boolean {
  const secret = config.SLACK_SIGNING_SECRET;
  if (!secret || !timestamp || !signature) return false;

  // Slack's documented replay window.
  const age = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (!Number.isFinite(age) || age > 300) return false;

  const expected = `v0=${createHmac("sha256", secret).update(`v0:${timestamp}:${raw}`).digest("hex")}`;
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && timingSafeEqual(a, b);
}

/* ---------------------------------------------- Airtable and n8n ingress */

webhookRoutes.post("/webhooks/:slug/:instanceId", async (c) => {
  const slug = c.req.param("slug");
  const instanceId = Number(c.req.param("instanceId"));
  if (!Number.isInteger(instanceId)) return c.json({ ok: false }, 400);

  const raw = await c.req.text();

  const [instance] = await db
    .select()
    .from(connectorInstances)
    .where(
      and(eq(connectorInstances.id, instanceId), eq(connectorInstances.connector, slug)),
    )
    .limit(1);
  if (!instance) return c.json({ ok: false }, 404);

  if (slug === "airtable") {
    const { verifyAirtablePing } = await import("../reflex/airtable-webhooks.js");
    const ok = await verifyAirtablePing(
      instance.orgId,
      instanceId,
      raw,
      c.req.header("x-airtable-content-mac"),
    );
    if (!ok) return c.json({ ok: false }, 401);

    const delivery = createHash("sha256").update(raw).digest("hex");
    if (alreadySeen(`airtable:${instanceId}:${delivery}`)) return c.json({ ok: true });

    // Airtable pings carry no payload — the job fetches them with a cursor.
    await enqueue(
      "webhook.fetch_payloads",
      { instanceId },
      {
        orgId: instance.orgId,
        dedupeKey: `webhook.fetch_payloads:${instanceId}`,
        priority: 8,
      },
    );
    return c.json({ ok: true });
  }

  if (slug === "n8n") {
    // n8n does not sign its outbound calls, so the per-instance secret is a
    // bearer token in the header. Documented honestly as bearer-URL security,
    // not signatures.
    const { verifyN8nHook } = await import("../reflex/airtable-webhooks.js");
    const ok = await verifyN8nHook(
      instance.orgId,
      instanceId,
      c.req.header("x-sadhak-secret"),
    );
    if (!ok) return c.json({ ok: false }, 401);

    const payload = JSON.parse(raw) as { workflowId?: string; event?: string };
    const delivery = createHash("sha256").update(raw).digest("hex");
    if (alreadySeen(`n8n:${instanceId}:${delivery}`)) return c.json({ ok: true });

    await enqueue(
      "reflex.n8n_push",
      { instanceId, workflowId: payload.workflowId, event: payload.event },
      { orgId: instance.orgId, priority: 8 },
    );
    return c.json({ ok: true });
  }

  return c.json({ ok: false, reason: `No ingress for connector "${slug}"` }, 404);
});

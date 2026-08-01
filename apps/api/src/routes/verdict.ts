import { changeDescriptorSchema } from "@sadhak/shared/types";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { NotFoundError } from "../errors.js";
import { requireCapability } from "../middleware/auth.js";
import { explainVerdict, explanationsAvailable } from "../sentinel/explain.js";
import { blastRadius, getVerdict, renderVerdict } from "../sentinel/verdict.js";
import { traced } from "../tracing.js";

export const verdictRoutes = new Hono();

verdictRoutes.post("/verdicts", requireCapability("gate:invoke"), async (c) => {
  const orgId = c.get("orgId");
  const actor = c.get("actor");
  const change = changeDescriptorSchema.parse(await c.req.json());

  // Span name matches the SLO vocabulary, so a latency
  // objective and the thing measuring it cannot drift apart.
  const result = await traced(
    "sadhak.verdict",
    {
      "sadhak.change.target": change.target,
      "sadhak.change.operation": change.operation,
    },
    () =>
      renderVerdict(orgId, change, {
        createdBy: actor.type === "user" ? actor.email : `api_key:${actor.id}`,
      }),
  );
  return c.json(result);
});

verdictRoutes.get("/verdicts/:id", requireCapability("graph:read"), async (c) => {
  const result = await getVerdict(c.get("orgId"), c.req.param("id"));
  if (!result) throw new NotFoundError();
  return c.json(result);
});

/** Read-only traversal: a question, not a proposal, so no decision row. */
verdictRoutes.post("/blast-radius", requireCapability("graph:read"), async (c) => {
  const change = changeDescriptorSchema.parse(await c.req.json());
  return c.json({ impacted: await blastRadius(c.get("orgId"), change) });
});

/**
 * The explanation stream. The verdict is already complete and persisted before
 * this route is called — every terminal event here is a designed state, and
 * none of them changes the verdict.
 */
verdictRoutes.get(
  "/verdicts/:id/explanation",
  requireCapability("graph:read"),
  async (c) => {
    const orgId = c.get("orgId");
    const result = await getVerdict(orgId, c.req.param("id"));
    if (!result) throw new NotFoundError();

    // Proxies buffer compressed streams; this route must not be compressed.
    c.header("Cache-Control", "no-cache");
    c.header("X-Accel-Buffering", "no");

    return streamSSE(c, async (stream) => {
      if (!explanationsAvailable()) {
        await stream.writeSSE({ event: "disabled", data: JSON.stringify({}) });
        return;
      }

      const controller = new AbortController();
      stream.onAbort(() => controller.abort());

      try {
        for await (const event of explainVerdict(orgId, result, controller.signal)) {
          switch (event.type) {
            case "delta":
              await stream.writeSSE({
                event: "delta",
                data: JSON.stringify({ text: event.text }),
              });
              break;
            case "done":
              await stream.writeSSE({
                event: "done",
                data: JSON.stringify({ text: event.text }),
              });
              break;
            case "quota_exhausted":
              await stream.writeSSE({
                event: "quota_exhausted",
                data: JSON.stringify({ resetAt: event.resetAt }),
              });
              break;
            case "disabled":
              await stream.writeSSE({ event: "disabled", data: JSON.stringify({}) });
              break;
            case "failed":
              await stream.writeSSE({ event: "failed", data: JSON.stringify({}) });
              break;
          }
        }
      } catch {
        await stream.writeSSE({ event: "failed", data: JSON.stringify({}) });
      }
    });
  },
);

export const explanationStateSchema = z.enum([
  "pending",
  "streamed",
  "failed",
  "disabled",
  "quota_exhausted",
]);

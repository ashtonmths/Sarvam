import { rationale, rationaleLinks } from "@sadhak/shared/schema";
import { z } from "zod";
import { auditSystem } from "../audit.js";
import { db } from "../db.js";
import { enqueue } from "../jobs/queue.js";

/**
 * Capture-forward: rationale at the moment of change.
 *
 * Mining recovers what Slack retention permits; this makes every gated change
 * a permanent, confirmed, source-linked rationale from install day onward,
 * independent of any vendor's retention tier. It is the compounding asset —
 * mining is the land motion.
 *
 * The helper never synthesizes a URL. Each surface owns a different permanent
 * artifact — a Slack thread reply for Reflex, a decision page for gate WARNs —
 * and hands its own in.
 */

export const captureInputSchema = z
  .object({
    orgId: z.number().int(),
    sourceUrl: z.string().url(),
    text: z.string().min(1).max(4000),
    /** Who wrote the words. */
    author: z.string().min(1),
    /** Who is making the API call. Confirmed-at-birth requires these to match. */
    actor: z.string().min(1),
    /**
     * When the words were written, if the surface knows. Capture-forward
     * surfaces are typing it now, so leaving this unset is the honest default
     * and the column stays null rather than claiming crawl time was authoring
     * time. A surface capturing an older artifact passes its real timestamp.
     */
    authoredAt: z.coerce.date().optional(),
    edgeIds: z.array(z.number().int()).default([]),
    decisionId: z.number().int().optional(),
    incidentId: z.number().int().optional(),
  })
  .refine(
    (v) => (v.decisionId === undefined) !== (v.incidentId === undefined),
    "Exactly one of decisionId or incidentId is required — they are different tables",
  );

export type CaptureInput = z.infer<typeof captureInputSchema>;

export interface CapturedRationale {
  id: number;
  state: "confirmed" | "drafted";
}

export async function captureRationale(raw: CaptureInput): Promise<CapturedRationale> {
  const input = captureInputSchema.parse(raw);

  /**
   * Auto-confirm, narrowly stated: a human_capture row is born confirmed
   * *only* when the author is the authenticated actor typing their own reason.
   * That is not draft laundering — the human authored the artifact and the
   * citation resolves to the decision record. An admin pasting someone else's
   * words enters as `drafted`, and the rule lives here rather than in callers
   * so no surface can quietly bypass it.
   */
  const selfAuthored = input.author === input.actor;
  const state = selfAuthored ? "confirmed" : "drafted";

  const [row] = await db
    .insert(rationale)
    .values({
      orgId: input.orgId,
      body: input.text,
      sourceKind: "human_capture",
      sourceUrl: input.sourceUrl,
      author: input.author,
      // Defaults to now because a human_capture row *is* being authored now —
      // the two are minutes apart. An explicit value wins where the caller
      // knows better.
      authoredAt: input.authoredAt ?? new Date(),
      state,
      // Embedding is computed on the worker; the request path never touches
      // transformers.js.
      embedding: null,
      ...(selfAuthored ? { confirmedBy: input.actor, confirmedAt: new Date() } : {}),
    })
    .returning({ id: rationale.id });

  const rationaleId = row?.id;
  if (!rationaleId) throw new Error("failed to insert captured rationale");

  if (input.edgeIds.length > 0) {
    await db
      .insert(rationaleLinks)
      .values(input.edgeIds.map((edgeId) => ({ rationaleId, edgeId })))
      .onConflictDoNothing();
  }

  await enqueue(
    "rationale.embed",
    {},
    { orgId: input.orgId, dedupeKey: "rationale.embed" },
  );

  await auditSystem(
    "rationale.captured",
    input.orgId,
    { kind: "rationale", id: rationaleId },
    {
      state,
      ...(input.decisionId === undefined ? {} : { decisionId: input.decisionId }),
      ...(input.incidentId === undefined ? {} : { incidentId: input.incidentId }),
    },
  );

  return { id: rationaleId, state };
}

/** Fill-rate counters: the leading indicator of whether the loop is turning. */
export const captureCounters = { offered: 0, filled: 0 };

export function recordCaptureOffered(): void {
  captureCounters.offered += 1;
}

export function recordCaptureFilled(): void {
  captureCounters.filled += 1;
}

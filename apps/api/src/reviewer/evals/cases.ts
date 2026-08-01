/**
 * Planted truth for the triage agent.
 *
 * Each case is a drift finding whose correct answer a human already knows, so
 * the agent's judgment can be scored against something other than its own
 * confidence.
 *
 * The scoring is deliberately asymmetric, because the errors are. Calling a
 * real breakage `benign` is the dangerous direction — it clears the finding
 * from the queue and, if a human agrees, mutes the signature for 30 days.
 * Calling something benign `real` costs one person one glance. An eval that
 * reported a single accuracy percentage would average those together and hide
 * the only number that matters.
 *
 * `unsure` is never counted as an error. The prompt tells the agent that not
 * knowing is a respectable answer, and an eval that punished it would train
 * exactly the overconfidence the whole design avoids.
 */

export type Expected = "benign" | "real";

export interface EvalCase {
  name: string;
  /** What a competent human would say, and why it is not a judgment call. */
  expected: Expected;
  why: string;
  scope: string;
  documentedState: Record<string, unknown>;
  liveState: Record<string, unknown>;
}

export const EVAL_CASES: EvalCase[] = [
  {
    name: "revenue-field-deleted",
    expected: "real",
    why: "A field feeding a VAT report disappeared. This is the product's own worst case.",
    scope: "field/db/billing/column/public.invoices.vat_rate",
    documentedState: { hash: "a1", name: "vat_rate", kind: "field", edgeCount: 2 },
    liveState: { hash: null },
  },
  {
    name: "workflow-step-disabled",
    expected: "real",
    why: "A disabled step stops doing its job while still appearing to exist.",
    scope: "step/n8n/workflow/17/step/sync-billing",
    documentedState: { hash: "b1", name: "sync-billing", disabled: false },
    liveState: { hash: "b2", name: "sync-billing", disabled: true },
  },
  {
    name: "field-retyped-narrower",
    expected: "real",
    why: "numeric to integer silently truncates every value downstream.",
    scope: "field/db/billing/column/public.invoices.vat_rate",
    documentedState: { hash: "c1", columnType: "numeric" },
    liveState: { hash: "c2", columnType: "integer" },
  },
  {
    name: "connection-rewired",
    expected: "real",
    why: "The same step now reads from somewhere else. The map's edge is wrong.",
    scope: "step/n8n/workflow/17/step/read",
    documentedState: { hash: "d1", reads: "invoices" },
    liveState: { hash: "d2", reads: "invoices_archive" },
  },
  {
    name: "canvas-position-moved",
    expected: "benign",
    why: "Someone dragged a node on the editor canvas. No wiring changed.",
    scope: "workflow/n8n/workflow/17",
    documentedState: { hash: "e1", position: [100, 200], connections: { a: ["b"] } },
    liveState: { hash: "e2", position: [900, 40], connections: { a: ["b"] } },
  },
  {
    name: "description-text-edited",
    expected: "benign",
    why: "A human-readable note changed. Nothing reads it programmatically.",
    scope: "workflow/n8n/workflow/17",
    documentedState: { hash: "f1", notes: "syncs nightly" },
    liveState: { hash: "f2", notes: "syncs nightly (owner: Priya)" },
  },
  {
    name: "scratch-table-appeared",
    expected: "benign",
    why: "A new table nothing references yet. Additive, with no dependents.",
    scope: "table/db/billing/table/public.tmp_import_scratch",
    documentedState: { hash: null },
    liveState: { hash: "g1", name: "tmp_import_scratch", edgeCount: 0 },
  },
];

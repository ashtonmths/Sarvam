/**
 * Heuristic seeding. Pure and table-driven so every rule is unit testable
 * without a database. Seeds must be plausible on day one; the corrections
 * humans make on top are the compounding proprietary data.
 */

/**
 * Node names are snake_case, dotted and spaced — `vat_rate`, `public.invoices`,
 * `Stripe Sandbox Sync` — so `\b` is the wrong boundary: `_` is a word
 * character, and `\bvat\b` therefore fails on `vat_rate`, the single most
 * important name in the fixture set. Letters and digits are the only things
 * that count as "inside a word" here.
 */
function term(...alternatives: string[]): RegExp {
  return new RegExp(`(^|[^a-z0-9])(${alternatives.join("|")})([^a-z0-9]|$)`, "i");
}

/**
 * First match wins, and revenue stays ahead of sandbox deliberately: a name
 * like `invoices_test` is ambiguous, and on a merge gate the safe reading of
 * an ambiguous name is the high one. A false BLOCK costs an argument; a false
 * APPROVE costs the payment flow.
 *
 * Matching whole terms is the fix that belongs here. Unanchored, `vat` matched
 * `private_data`, `tax` matched `syntax` and `charge` matched `recharge_cache`,
 * each seeding routine tooling as revenue-touching — accidents, not the
 * conservative choice above.
 */
const NAME_RULES: [RegExp, number][] = [
  [
    term(
      "invoice",
      "invoices",
      "billing",
      "payment",
      "payments",
      "payout",
      "payouts",
      "refund",
      "refunds",
      "charge",
      "charges",
      "subscription",
      "subscriptions",
      "vat",
      "tax",
      "taxes",
      "stripe",
      "ledger",
      "ledgers",
    ),
    1.0,
  ],
  [
    term(
      "customer",
      "customers",
      "crm",
      "onboarding",
      "onboard",
      "order",
      "orders",
      "email",
      "emails",
      "notification",
      "notifications",
      "notify",
    ),
    0.7,
  ],
  [term("test", "tests", "sandbox", "demo", "scratch", "tmp", "temp", "playground"), 0.1],
];

/** A blandly-named flow that touches one of these is not internal tooling. */
const PAYMENT_HOSTS =
  /(^|\.)(stripe\.com|paypal\.com|chargebee\.com|razorpay\.com|adyen\.com|braintreegateway\.com)$/i;

export const DEFAULT_CRITICALITY = 0.4;

export function seedFromName(name: string): number {
  for (const [pattern, value] of NAME_RULES) {
    if (pattern.test(name)) return value;
  }
  return DEFAULT_CRITICALITY;
}

export function seedFromHost(host: string): number {
  return PAYMENT_HOSTS.test(host) ? 1.0 : DEFAULT_CRITICALITY;
}

export interface SeedInput {
  kind: string;
  name: string;
  metadata: Record<string, unknown>;
}

export function seedCriticality(node: SeedInput): number {
  const byName = seedFromName(node.name);

  if (node.kind === "endpoint" || node.kind === "service") {
    const host = typeof node.metadata.host === "string" ? node.metadata.host : node.name;
    return Math.max(byName, seedFromHost(host));
  }

  return byName;
}

/**
 * Structural pass, applied post-fusion: a workflow inherits the max
 * criticality of anything it (via its steps) writes to, and a credential the
 * max of its dependents. Runs over the whole batch because the answer depends
 * on edges, not on any single node.
 */
export function propagateStructural(
  nodes: Map<string, { kind: string; criticality: number }>,
  edges: Array<{ src: string; dst: string; kind: string }>,
): void {
  // step → target (WRITES_TO), so a step is at least as critical as what it writes.
  for (const edge of edges) {
    if (edge.kind !== "WRITES_TO") continue;
    const step = nodes.get(edge.src);
    const target = nodes.get(edge.dst);
    if (step && target) step.criticality = Math.max(step.criticality, target.criticality);
  }

  // workflow → step (DERIVES_FROM): the workflow inherits its steps' maximum.
  for (const edge of edges) {
    if (edge.kind !== "DERIVES_FROM") continue;
    const workflow = nodes.get(edge.src);
    const step = nodes.get(edge.dst);
    if (workflow?.kind === "workflow" && step) {
      workflow.criticality = Math.max(workflow.criticality, step.criticality);
    }
  }

  // step → credential (AUTHENTICATES_WITH): a credential is as critical as
  // the most critical thing that depends on it.
  for (const edge of edges) {
    if (edge.kind !== "AUTHENTICATES_WITH") continue;
    const step = nodes.get(edge.src);
    const credential = nodes.get(edge.dst);
    if (credential && step) {
      credential.criticality = Math.max(credential.criticality, step.criticality);
    }
  }
}

/** The four canonical stops the UI offers; the API accepts the continuum. */
export const CANONICAL_STOPS = [1.0, 0.7, 0.4, 0.1] as const;

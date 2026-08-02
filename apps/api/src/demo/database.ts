import postgres from "postgres";
import { runCrawl } from "../cartographer/index.js";
import { config } from "../config.js";
import { sql as raw } from "../db.js";
import { log } from "../log.js";

/**
 * Grows the demo company's database, then re-crawls it.
 *
 * db/init only runs against an empty data volume, so a deployment that has
 * already booted never sees a schema added later — which meant the richer
 * billing schema existed in the repository and nowhere a hosted demo could
 * reach it.
 *
 * This connects with the API's own Postgres credentials, swapping only the
 * database name, because the connector credential is deliberately read-only:
 * it holds CONNECT and SELECT on the catalog and nothing that could create a
 * table. Creating one is an operator action and this is the operator's
 * connection, used against the demo database alone.
 *
 * Everything is IF NOT EXISTS or OR REPLACE, so the button is safe to press
 * twice — and every object it makes is then read back through
 * information_schema like any other, rather than written into the graph.
 */

const DEMO_DB = "demo_billing";

const SCHEMA = `  CREATE TABLE IF NOT EXISTS plans (
    id            BIGSERIAL PRIMARY KEY,
    code          TEXT NOT NULL UNIQUE,
    name          TEXT NOT NULL,
    monthly_cents BIGINT NOT NULL,
    currency      TEXT NOT NULL DEFAULT 'EUR',
    active        BOOLEAN NOT NULL DEFAULT true
  );

  CREATE TABLE IF NOT EXISTS subscriptions (
    id           BIGSERIAL PRIMARY KEY,
    customer_id  BIGINT NOT NULL REFERENCES customers(id),
    plan_id      BIGINT NOT NULL REFERENCES plans(id),
    started_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    cancelled_at TIMESTAMPTZ,
    -- Set when a customer negotiates off list price. The revenue views read it.
    discount_pct NUMERIC(5,4)
  );

  CREATE TABLE IF NOT EXISTS payments (
    id          BIGSERIAL PRIMARY KEY,
    invoice_id  BIGINT NOT NULL REFERENCES invoices(id),
    amount_cents BIGINT NOT NULL,
    currency    TEXT NOT NULL DEFAULT 'EUR',
    method      TEXT NOT NULL,
    provider_ref TEXT,
    paid_at     TIMESTAMPTZ NOT NULL DEFAULT now()
  );

  CREATE TABLE IF NOT EXISTS refunds (
    id          BIGSERIAL PRIMARY KEY,
    payment_id  BIGINT NOT NULL REFERENCES payments(id),
    amount_cents BIGINT NOT NULL,
    reason      TEXT,
    refunded_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );

  CREATE TABLE IF NOT EXISTS credit_notes (
    id          BIGSERIAL PRIMARY KEY,
    invoice_id  BIGINT NOT NULL REFERENCES invoices(id),
    amount_cents BIGINT NOT NULL,
    reason      TEXT NOT NULL,
    issued_at   TIMESTAMPTZ NOT NULL DEFAULT now()
  );

  CREATE TABLE IF NOT EXISTS ledger_entries (
    id          BIGSERIAL PRIMARY KEY,
    payment_id  BIGINT REFERENCES payments(id),
    refund_id   BIGINT REFERENCES refunds(id),
    account     TEXT NOT NULL,
    debit_cents BIGINT NOT NULL DEFAULT 0,
    credit_cents BIGINT NOT NULL DEFAULT 0,
    booked_at   TIMESTAMPTZ NOT NULL DEFAULT now()
  );

  CREATE TABLE IF NOT EXISTS tax_rates (
    id         BIGSERIAL PRIMARY KEY,
    country    TEXT NOT NULL,
    rate       NUMERIC(5,4) NOT NULL,
    valid_from DATE NOT NULL,
    valid_to   DATE
  );

  CREATE TABLE IF NOT EXISTS dunning_attempts (
    id          BIGSERIAL PRIMARY KEY,
    invoice_id  BIGINT NOT NULL REFERENCES invoices(id),
    attempt     INTEGER NOT NULL DEFAULT 1,
    channel     TEXT NOT NULL DEFAULT 'email',
    sent_at     TIMESTAMPTZ NOT NULL DEFAULT now()
  );

  -- Views. These are where the interesting edges come from: each one reads
  -- across several tables, so dropping a column in any of them breaks
  -- something a person named rather than something abstract.

  CREATE OR REPLACE VIEW outstanding_invoices AS
    SELECT i.id, i.customer_id, i.amount_cents, i.currency, i.issued_at,
           coalesce(sum(p.amount_cents), 0) AS paid_cents
      FROM invoices i
      LEFT JOIN payments p ON p.invoice_id = i.id
     GROUP BY i.id, i.customer_id, i.amount_cents, i.currency, i.issued_at
    HAVING coalesce(sum(p.amount_cents), 0) < i.amount_cents;

  CREATE OR REPLACE VIEW monthly_recurring_revenue AS
    SELECT date_trunc('month', s.started_at) AS period,
           c.country,
           sum(pl.monthly_cents * (1 - coalesce(s.discount_pct, 0))) AS mrr_cents
      FROM subscriptions s
      JOIN plans pl ON pl.id = s.plan_id
      JOIN customers c ON c.id = s.customer_id
     WHERE s.cancelled_at IS NULL
     GROUP BY 1, 2;

  CREATE OR REPLACE VIEW refund_rate_by_method AS
    SELECT p.method,
           count(DISTINCT p.id) AS payments,
           count(DISTINCT r.id) AS refunds,
           coalesce(sum(r.amount_cents), 0) AS refunded_cents
      FROM payments p
      LEFT JOIN refunds r ON r.payment_id = p.id
     GROUP BY p.method;

  CREATE OR REPLACE VIEW revenue_recognition AS
    SELECT date_trunc('month', l.booked_at) AS period,
           l.account,
           sum(l.debit_cents) AS debit_cents,
           sum(l.credit_cents) AS credit_cents
      FROM ledger_entries l
     GROUP BY 1, 2;

  CREATE OR REPLACE VIEW dunning_queue AS
    SELECT o.id AS invoice_id, o.customer_id, o.amount_cents, o.issued_at,
           count(d.id) AS attempts
      FROM outstanding_invoices o
      LEFT JOIN dunning_attempts d ON d.invoice_id = o.id
     GROUP BY o.id, o.customer_id, o.amount_cents, o.issued_at;

  INSERT INTO plans (code, name, monthly_cents) VALUES
    ('starter', 'Starter', 4900), ('growth', 'Growth', 19900), ('scale', 'Scale', 79900)
  ON CONFLICT (code) DO NOTHING;
`;

export async function expandDemoDatabase(
  orgId: number,
): Promise<{ relations: number; nodes: number; edges: number }> {
  // Same host, same credentials, different database.
  const url = new URL(config.DATABASE_URL);
  url.pathname = `/${DEMO_DB}`;

  // One connection, closed in a finally: this runs from a request, and a demo
  // button that leaks a pooled connection per press exhausts Postgres before
  // anyone notices why.
  const target = postgres(url.toString(), { max: 1, onnotice: () => {} });
  let relations = 0;
  try {
    await target.unsafe(SCHEMA);
    const rows = (await target.unsafe(
      "SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'public'",
    )) as unknown as Array<{ n: number }>;
    relations = rows[0]?.n ?? 0;
  } finally {
    await target.end({ timeout: 5 });
  }

  // Re-crawl every Postgres instance this org has, so the map catches up.
  const instances = (await raw`
    SELECT id FROM connector_instances
    WHERE org_id = ${orgId} AND connector = 'postgres'
  `) as unknown as Array<{ id: number }>;

  let nodes = 0;
  let edges = 0;
  for (const instance of instances) {
    const out = await runCrawl(orgId, Number(instance.id));
    const stats = out.stats as { nodesSeen?: number; edgesSeen?: number } | undefined;
    nodes += stats?.nodesSeen ?? 0;
    edges += stats?.edgesSeen ?? 0;
  }

  log().info(
    { event: "demo_db_expanded", orgId, nodes, edges },
    "demo: database expanded",
  );
  return { relations, nodes, edges };
}

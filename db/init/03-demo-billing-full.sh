#!/bin/bash
# The rest of the demo company's billing database.
#
# Split from 02 so the original two tables stay the minimal thing the tests and
# the README describe, while a demo gets a schema with enough shape to be worth
# looking at: subscriptions and payments hanging off customers, refunds and
# ledger entries hanging off payments, and four views that read across them.
#
# Everything here is crawled rather than seeded. The graph Sadhak draws is
# derived from information_schema and the view definitions below, so a column
# dropped here disappears from the map on the next crawl — which is the claim
# the map makes and the reason this is a real schema rather than fixture rows.
set -e
psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d demo_billing <<-'SQL'
  CREATE TABLE plans (
    id            BIGSERIAL PRIMARY KEY,
    code          TEXT NOT NULL UNIQUE,
    name          TEXT NOT NULL,
    monthly_cents BIGINT NOT NULL,
    currency      TEXT NOT NULL DEFAULT 'EUR',
    active        BOOLEAN NOT NULL DEFAULT true
  );

  CREATE TABLE subscriptions (
    id           BIGSERIAL PRIMARY KEY,
    customer_id  BIGINT NOT NULL REFERENCES customers(id),
    plan_id      BIGINT NOT NULL REFERENCES plans(id),
    started_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    cancelled_at TIMESTAMPTZ,
    -- Set when a customer negotiates off list price. The revenue views read it.
    discount_pct NUMERIC(5,4)
  );

  CREATE TABLE payments (
    id          BIGSERIAL PRIMARY KEY,
    invoice_id  BIGINT NOT NULL REFERENCES invoices(id),
    amount_cents BIGINT NOT NULL,
    currency    TEXT NOT NULL DEFAULT 'EUR',
    method      TEXT NOT NULL,
    provider_ref TEXT,
    paid_at     TIMESTAMPTZ NOT NULL DEFAULT now()
  );

  CREATE TABLE refunds (
    id          BIGSERIAL PRIMARY KEY,
    payment_id  BIGINT NOT NULL REFERENCES payments(id),
    amount_cents BIGINT NOT NULL,
    reason      TEXT,
    refunded_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );

  CREATE TABLE credit_notes (
    id          BIGSERIAL PRIMARY KEY,
    invoice_id  BIGINT NOT NULL REFERENCES invoices(id),
    amount_cents BIGINT NOT NULL,
    reason      TEXT NOT NULL,
    issued_at   TIMESTAMPTZ NOT NULL DEFAULT now()
  );

  CREATE TABLE ledger_entries (
    id          BIGSERIAL PRIMARY KEY,
    payment_id  BIGINT REFERENCES payments(id),
    refund_id   BIGINT REFERENCES refunds(id),
    account     TEXT NOT NULL,
    debit_cents BIGINT NOT NULL DEFAULT 0,
    credit_cents BIGINT NOT NULL DEFAULT 0,
    booked_at   TIMESTAMPTZ NOT NULL DEFAULT now()
  );

  CREATE TABLE tax_rates (
    id         BIGSERIAL PRIMARY KEY,
    country    TEXT NOT NULL,
    rate       NUMERIC(5,4) NOT NULL,
    valid_from DATE NOT NULL,
    valid_to   DATE
  );

  CREATE TABLE dunning_attempts (
    id          BIGSERIAL PRIMARY KEY,
    invoice_id  BIGINT NOT NULL REFERENCES invoices(id),
    attempt     INTEGER NOT NULL DEFAULT 1,
    channel     TEXT NOT NULL DEFAULT 'email',
    sent_at     TIMESTAMPTZ NOT NULL DEFAULT now()
  );

  -- Views. These are where the interesting edges come from: each one reads
  -- across several tables, so dropping a column in any of them breaks
  -- something a person named rather than something abstract.

  CREATE VIEW outstanding_invoices AS
    SELECT i.id, i.customer_id, i.amount_cents, i.currency, i.issued_at,
           coalesce(sum(p.amount_cents), 0) AS paid_cents
      FROM invoices i
      LEFT JOIN payments p ON p.invoice_id = i.id
     GROUP BY i.id, i.customer_id, i.amount_cents, i.currency, i.issued_at
    HAVING coalesce(sum(p.amount_cents), 0) < i.amount_cents;

  CREATE VIEW monthly_recurring_revenue AS
    SELECT date_trunc('month', s.started_at) AS period,
           c.country,
           sum(pl.monthly_cents * (1 - coalesce(s.discount_pct, 0))) AS mrr_cents
      FROM subscriptions s
      JOIN plans pl ON pl.id = s.plan_id
      JOIN customers c ON c.id = s.customer_id
     WHERE s.cancelled_at IS NULL
     GROUP BY 1, 2;

  CREATE VIEW refund_rate_by_method AS
    SELECT p.method,
           count(DISTINCT p.id) AS payments,
           count(DISTINCT r.id) AS refunds,
           coalesce(sum(r.amount_cents), 0) AS refunded_cents
      FROM payments p
      LEFT JOIN refunds r ON r.payment_id = p.id
     GROUP BY p.method;

  CREATE VIEW revenue_recognition AS
    SELECT date_trunc('month', l.booked_at) AS period,
           l.account,
           sum(l.debit_cents) AS debit_cents,
           sum(l.credit_cents) AS credit_cents
      FROM ledger_entries l
     GROUP BY 1, 2;

  CREATE VIEW dunning_queue AS
    SELECT o.id AS invoice_id, o.customer_id, o.amount_cents, o.issued_at,
           count(d.id) AS attempts
      FROM outstanding_invoices o
      LEFT JOIN dunning_attempts d ON d.invoice_id = o.id
     GROUP BY o.id, o.customer_id, o.amount_cents, o.issued_at;

  INSERT INTO plans (code, name, monthly_cents) VALUES
    ('starter', 'Starter', 4900), ('growth', 'Growth', 19900), ('scale', 'Scale', 79900);
SQL

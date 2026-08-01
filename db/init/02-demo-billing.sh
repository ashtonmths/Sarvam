#!/bin/bash
# The demo company's billing database. Sadhak reads information_schema here,
# exactly as it would against a customer's Postgres.
set -e
psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d demo_billing <<-'SQL'
  CREATE TABLE customers (
    id          BIGSERIAL PRIMARY KEY,
    name        TEXT NOT NULL,
    country     TEXT NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
  );

  CREATE TABLE invoices (
    id           BIGSERIAL PRIMARY KEY,
    customer_id  BIGINT NOT NULL REFERENCES customers(id),
    amount_cents BIGINT NOT NULL,
    currency     TEXT NOT NULL DEFAULT 'EUR',
    -- The field the whole demo turns on. Looks unused. Is not.
    vat_rate     NUMERIC(5,4),
    issued_at    TIMESTAMPTZ NOT NULL DEFAULT now()
  );

  CREATE VIEW eu_vat_report AS
    SELECT c.country,
           date_trunc('month', i.issued_at) AS period,
           sum(i.amount_cents * i.vat_rate)  AS vat_due_cents
      FROM invoices i
      JOIN customers c ON c.id = i.customer_id
     GROUP BY 1, 2;
SQL

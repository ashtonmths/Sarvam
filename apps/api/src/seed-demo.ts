import { closePools, db, sql as raw } from "./db.js";

/**
 * A demonstrable organisation, not a table of lorem ipsum.
 *
 * Everything here is one story: a VAT column that a finance report depends on,
 * a team that decided twice to keep it, a migration that dropped it anyway, the
 * workflow that broke at 03:12 the next morning, and the pull request somebody
 * had already opened to put it back. Every table points at the same handful of
 * entities, so following a thread across the product lands somewhere real —
 * the blast radius names the report the transcript argues about, the checkpoint
 * bounding the investigation is the release before the migration, and the
 * rationale waiting in the review queue quotes a line you can open.
 *
 * That coherence is the whole point. Data seeded per-table looks plausible on
 * every page and falls apart the moment anyone clicks through, which is exactly
 * what a demo does.
 *
 * Runs after `pnpm seed`, which creates the org and crawls the graph this
 * builds on. Idempotent: it clears its own rows first, so re-running gives the
 * same result rather than doubling everything.
 */

const ORG_SLUG = "acme-operations";
/** The demo clock. Everything is placed relative to "now" so it never ages. */
const NOW = Date.now();
const hoursAgo = (h: number) => new Date(NOW - h * 3_600_000);
const daysAgo = (d: number) => new Date(NOW - d * 86_400_000);

function log(message: string): void {
  console.log(message);
}

/* ------------------------------------------------------------ documents */

const TRANSCRIPTS = [
  {
    title: "Billing Schema Review — invoices.vat_rate",
    when: daysAgo(21),
    speaker: "Priya Raman",
    body: `[14:02] Priya Raman: Main item today is the invoices table. There's a proposal from the tax integration work to drop invoices.vat_rate, because we now pull live rates from Avalara at invoice time.
[14:03] Tom Okafor: Right. Keeping a vat_rate column means two sources of truth, and they drifted once already — January, the column said 19% and the service said 20% for a German customer.
[14:05] Lena Fischer: Those two numbers are not the same number. The tax service gives you the rate that applies today. The column stores the rate that was applied when the invoice was issued. For an invoice from 2023 those differ, and the one that matters legally is the one we charged at the time.
[14:06] Tom Okafor: Couldn't we recompute it? We know the issue date and the jurisdiction.
[14:07] Lena Fischer: Only if the rate table is complete going back seven years, and only if we never got it wrong. If we charged 19% when the correct rate was 20%, the invoice says 19%. That is the document the customer holds and what an auditor reconciles against. Recomputing rewrites history to what we should have charged rather than what we did.
[14:11] Marcus Webb: public.eu_vat_report derives from invoices.vat_rate. Drop the column and the report does not degrade, it fails outright.
[14:12] Lena Fischer: And that report is the one we file quarterly. It is not internal.
[14:14] Lena Fischer: We keep it, and we should be explicit that it is a historical record and not a cache. Nobody should ever backfill it from the live rate table.

DECISIONS
1. invoices.vat_rate stays. It is the rate applied at the time of issue.
2. Nobody backfills or recomputes it from the current rate table.
3. public.eu_vat_report depends on it. Removing the column breaks a regulatory filing.
4. The January drift is closed as a reconciliation bug, not a column problem.

[14:38] Lena Fischer: Please keep these notes findable. This is the third time in two years someone has proposed dropping that column.`,
  },
  {
    title: "Handover — billing pipeline, Priya to Dev",
    when: daysAgo(9),
    speaker: "Priya Raman",
    body: `Priya Raman: Two things about the billing pipeline that are not written down anywhere else.

First, the Quarterly VAT filing workflow in n8n reads invoices directly rather than going through the API. That was deliberate — the API paginates and the filing needs a consistent snapshot — but it means schema changes hit it without any deploy of ours. If a column it reads disappears, the workflow is how you find out.

Second, customers.country is populated from the billing address, not the shipping one. Somebody will eventually "fix" this to use shipping. It is not a bug. The EU VAT report groups on it and the tax authority cares where the customer is established, not where the parcel went.

Dev Kulkarni: Is there anything that would catch the first one before it fires?
Priya Raman: The dependency is in the map, so the gate warns on it. Whether anyone reads the warning is a different question.`,
  },
  {
    title: "Postmortem — reconciliation job flagged healthy invoices",
    when: daysAgo(34),
    speaker: "Tom Okafor",
    body: `Tom Okafor: Summary. For eleven days the nightly reconciliation job flagged roughly four hundred invoices as mismatched. None of them were wrong.

What happened: the job compared invoices.vat_rate against the rate the tax service returns today. Those are different numbers by design — one is historical, one is current — so every invoice issued before a rate change looked like a discrepancy.

Why it took eleven days: the alert fired into a channel nobody owns, and the count was large enough from day one that it read as a known-bad baseline rather than a new failure.

Fix: the comparison was removed. The column is authoritative for what was charged.

Lena Fischer: Worth saying explicitly — this incident is the reason someone proposed dropping the column. The drift was real, the conclusion drawn from it was wrong.`,
  },
  {
    title: "Runbook — Quarterly VAT filing workflow",
    when: daysAgo(45),
    speaker: null,
    body: `Quarterly VAT filing — n8n workflow runbook

What it does: reads issued invoices for the quarter, groups by customers.country, applies invoices.vat_rate as charged, and produces the filing CSV.

Schedule: 03:00 UTC on the first of each month, and on demand.

Inputs it reads directly: public.invoices (id, customer_id, amount_cents, vat_rate, issued_at), public.customers (id, country).

If it fails with a missing column: do not add the column back with a default. A default silently writes a rate that was never charged. Restore from the migration that removed it, or backfill from the issued invoices themselves.

If it fails with a timeout: the snapshot query is unindexed on issued_at by design — the filing is quarterly and the index costs more than it saves. Re-run it.

Escalation: finance systems owns the output, platform owns the workflow.`,
  },
];

/* -------------------------------------------------------------- changes */

const COMMITS = [
  {
    sha: "c9dafdde41b2a7e3f0c1d8b5a6e94f2c3d7b8a10",
    title: "chunk documents, add tables for uploaded documents, timezone fixes",
    author: "priya",
    at: hoursAgo(30),
    paths: ["apps/api/src/documents/chunk.ts", "apps/api/src/documents/ingest.ts"],
  },
  {
    sha: "7f3e1a9c8b2d4e6f0a1b3c5d7e9f2a4b6c8d0e12",
    title: "drop the vat_rate column now that Avalara returns it live",
    author: "tom",
    at: hoursAgo(14),
    paths: [
      "db/migrations/0031_drop_invoices_vat_rate.sql",
      "packages/shared/src/schema.ts",
      "apps/api/src/billing/invoice.ts",
    ],
  },
  {
    sha: "2b8c4d6e0f1a3b5c7d9e1f3a5b7c9d1e3f5a7b90",
    title: "point the reconciliation job at the tax service",
    author: "tom",
    at: hoursAgo(15),
    paths: ["apps/api/src/billing/reconcile.ts"],
  },
  {
    sha: "5e7a9c1b3d5f7a9c1e3b5d7f9a1c3e5b7d9f1a30",
    title: "raise the invoice export page size",
    author: "dev",
    at: hoursAgo(38),
    paths: ["apps/web/app/app/exports/page.tsx"],
  },
  {
    sha: "9d1f3b5a7c9e1d3f5b7a9c1e3d5f7b9a1c3e5d70",
    title: "release: billing 2026.7.3",
    author: "priya",
    at: hoursAgo(20),
    paths: ["CHANGELOG.md"],
  },
];

async function seedDocuments(orgId: number): Promise<void> {
  await raw`DELETE FROM documents WHERE org_id = ${orgId}`;

  for (const doc of TRANSCRIPTS) {
    const content = doc.body;
    const [row] = (await raw`
      INSERT INTO documents (org_id, title, content, byte_size, content_hash, occurred_at, uploaded_by, original_name)
      VALUES (${orgId}, ${doc.title}, ${content}, ${Buffer.byteLength(content)},
              md5(${content}), ${doc.when.toISOString()}::timestamptz, 'seed',
              ${`${doc.title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.txt`})
      RETURNING id
    `) as unknown as Array<{ id: number }>;
    if (!row) continue;

    /**
     * Chunked on blank lines, which is what the real ingester does for a
     * transcript. Left unembedded on purpose: the embed job sweeps for NULL
     * vectors, so a seeded document exercises that path rather than skipping
     * it, and semantic search starts working a minute after boot the same way
     * it would for a real upload.
     */
    const parts = content.split(/\n\n+/).filter((p) => p.trim());
    let offset = 0;
    for (const [i, part] of parts.entries()) {
      await raw`
        INSERT INTO document_chunks
          (org_id, document_id, ordinal, body, speaker, start_offset, end_offset, token_estimate)
        VALUES (${orgId}, ${row.id}, ${i}, ${part}, ${doc.speaker},
                ${offset}, ${offset + part.length}, ${Math.ceil(part.length / 4)})
      `;
      offset += part.length + 2;
    }
  }
  log(`documents: ${TRANSCRIPTS.length} transcripts, chunked and queued for embedding`);
}

async function seedChanges(orgId: number): Promise<number | null> {
  const [repo] = (await raw`
    SELECT id FROM repositories WHERE org_id = ${orgId} ORDER BY id LIMIT 1
  `) as unknown as Array<{ id: number }>;
  if (!repo) {
    log("changes: skipped, no repository is tracked yet");
    return null;
  }

  await raw`DELETE FROM changes WHERE org_id = ${orgId} AND external_id = ANY(${COMMITS.map((c) => c.sha)})`;

  for (const commit of COMMITS) {
    const [row] = (await raw`
      INSERT INTO changes (org_id, repo_id, kind, external_id, title, author_login, occurred_at, url)
      VALUES (${orgId}, ${repo.id}, 'commit', ${commit.sha}, ${commit.title},
              ${commit.author}, ${commit.at.toISOString()}::timestamptz,
              ${`https://github.com/ashtonmths/Sarvam/commit/${commit.sha}`})
      ON CONFLICT DO NOTHING
      RETURNING id
    `) as unknown as Array<{ id: number }>;
    if (!row) continue;
    for (const path of commit.paths) {
      await raw`INSERT INTO change_paths (change_id, path, status) VALUES (${row.id}, ${path}, 'modified')`;
    }
  }
  log(`changes: ${COMMITS.length} commits with file paths`);
  return repo.id;
}

/**
 * Checkpoints, placed so the investigation ladder has something to walk.
 *
 * The release twenty hours ago is the useful one: it sits *after* the document
 * work and *before* the migration, so an investigation of the 03:12 failure
 * opens on a window containing exactly the change that caused it. The crawl
 * checkpoints around it are the noise a real deployment produces, and they are
 * here so the ranking has something to get right.
 */
async function seedCheckpoints(orgId: number, repoId: number | null): Promise<void> {
  await raw`DELETE FROM checkpoints WHERE org_id = ${orgId} AND created_by = 'seed'`;

  const rows: Array<[string, number, string, string]> = [
    ["release", 20, "billing 2026.7.3 released and verified", "production"],
    ["manual", 26, "quarter close reconciled, everything green", "production"],
    ["crawl_healthy", 2, "connector crawl completed cleanly", "production"],
    ["crawl_healthy", 8, "connector crawl completed cleanly", "production"],
    ["release", 44, "billing 2026.7.2 released", "production"],
  ];

  for (const [kind, hours, label, environment] of rows) {
    await raw`
      INSERT INTO checkpoints (org_id, kind, repo_id, label, environment, occurred_at, created_by, confidence)
      VALUES (${orgId}, ${kind}, ${repoId}, ${label}, ${environment},
              ${hoursAgo(hours).toISOString()}::timestamptz, 'seed',
              ${kind === "manual" ? 0.95 : kind === "release" ? 0.85 : 0.4})
    `;
  }
  log(`checkpoints: ${rows.length}, including the release the migration landed after`);
}

/**
 * Rationale in both states, because coverage is deliberately two numbers.
 *
 * A drafted row is a proposal until a person confirms it against its source, so
 * the review queue has something in it and the coverage bar shows the gap
 * between what is known and what is merely suggested.
 */
async function seedRationale(orgId: number): Promise<void> {
  await raw`DELETE FROM rationale WHERE org_id = ${orgId} AND author = 'seed'`;

  const [doc] = (await raw`
    SELECT id FROM documents WHERE org_id = ${orgId} ORDER BY id LIMIT 1
  `) as unknown as Array<{ id: number }>;
  const link = doc ? `http://localhost:3000/app/documents/${doc.id}#chunk-3` : null;

  const rows: Array<[string, string, string | null]> = [
    [
      "confirmed",
      "invoices.vat_rate is the rate applied at the time of issue and is a historical record, not a cache of the live rate. The quarterly EU VAT filing reads it directly.",
      link,
    ],
    [
      "confirmed",
      "customers.country comes from the billing address rather than the shipping address, because the filing groups on where the customer is established.",
      link,
    ],
    [
      "drafted",
      "public.eu_vat_report depends on invoices.vat_rate. Removing the column breaks a regulatory filing rather than degrading an internal report.",
      link,
    ],
    [
      "drafted",
      "The reconciliation job must not compare vat_rate against the live tax service rate. Expected divergence is not an error.",
      link,
    ],
  ];

  for (const [state, body, sourceUrl] of rows) {
    await raw`
      INSERT INTO rationale (org_id, body, author, state, source_kind, source_url, authored_at, confidence, confirmed_at, confirmed_by)
      VALUES (${orgId}, ${body}, 'seed', ${state}, 'doc', ${sourceUrl},
              ${daysAgo(21).toISOString()}::timestamptz, 0.9,
              ${state === "confirmed" ? daysAgo(20).toISOString() : null},
              ${state === "confirmed" ? "demo@sadhak.online" : null})
    `;
  }
  log("rationale: 2 confirmed, 2 waiting in the review queue");
}

/**
 * Thirty days of gate decisions, shaped like a real week rather than noise.
 *
 * Weekdays carry traffic and weekends almost none, because a chart where every
 * bar is the same height tells a reader nothing and is obviously synthetic. The
 * blocks cluster near the migration, which is the point of the chart.
 */
async function seedMetrics(orgId: number): Promise<void> {
  await raw`DELETE FROM metric_rollups WHERE org_id = ${orgId}`;

  for (let d = 29; d >= 0; d--) {
    const day = daysAgo(d);
    const weekend = day.getUTCDay() === 0 || day.getUTCDay() === 6;
    const base = weekend ? 1 : 6 + ((d * 7) % 9);
    const approved = weekend ? Math.max(0, base - 1) : base;
    const warned = weekend ? 0 : d % 4 === 0 ? 2 : d % 3 === 0 ? 1 : 0;
    const blocked = d === 0 ? 2 : d === 1 ? 1 : d % 11 === 0 ? 1 : 0;

    for (const [metric, value] of [
      ["gate_approved", approved],
      ["gate_warned", warned],
      ["gate_blocked", blocked],
      ["incidents_detected", d === 0 ? 1 : 0],
      ["reverts_executed", d === 0 ? 1 : 0],
    ] as const) {
      await raw`
        INSERT INTO metric_rollups (org_id, metric, day, value, computed_at)
        VALUES (${orgId}, ${metric}, ${day.toISOString().slice(0, 10)}::date, ${value}, now())
        ON CONFLICT DO NOTHING
      `;
    }
  }
  log("metrics: 30 days of gate decisions, weekday-shaped");
}

/**
 * One incident, detected by push and reverted by a human.
 *
 * A single well-formed incident is worth more than twenty: it gives the metrics
 * page real detect-to-repair numbers instead of "not yet measured", and the
 * timestamps are minutes apart rather than seconds because a person was in the
 * loop and the page says so.
 */
async function seedIncident(orgId: number): Promise<void> {
  await raw`DELETE FROM reflex_incidents WHERE org_id = ${orgId} AND dedupe_key LIKE 'seed:%'`;

  const [node] = (await raw`
    SELECT id FROM nodes WHERE org_id = ${orgId} AND name = 'invoices.vat_rate' LIMIT 1
  `) as unknown as Array<{ id: number }>;

  await raw`
    INSERT INTO reflex_incidents
      (org_id, node_id, actor, connector, target, operation, external_id, state, detect_path,
       change_at, detected_at, verdict_at, alerted_at, acknowledged_at,
       revert_requested_at, reverted_at, verdict, dedupe_key)
    VALUES (${orgId}, ${node?.id ?? null},
            ${JSON.stringify({ kind: "user", id: "tom", label: "Tom Okafor" })}::jsonb,
            'postgres', 'public.invoices',
            'drop_column', 'public.invoices.vat_rate', 'reverted', 'push',
            ${hoursAgo(14).toISOString()}::timestamptz,
            ${new Date(NOW - 14 * 3600_000 + 9_000).toISOString()}::timestamptz,
            ${new Date(NOW - 14 * 3600_000 + 11_000).toISOString()}::timestamptz,
            ${new Date(NOW - 14 * 3600_000 + 13_000).toISOString()}::timestamptz,
            ${new Date(NOW - 14 * 3600_000 + 220_000).toISOString()}::timestamptz,
            ${new Date(NOW - 14 * 3600_000 + 240_000).toISOString()}::timestamptz,
            ${new Date(NOW - 14 * 3600_000 + 268_000).toISOString()}::timestamptz,
            'BLOCK', ${`seed:${orgId}:vat_rate`})
  `;
  log("incident: one detected-and-reverted, so detect-to-repair has real numbers");
}

/**
 * Slack channels marked as in scope for mining.
 *
 * These are the rows the connector settings page reads to decide which boxes
 * are ticked. The messages themselves live in Slack and cannot be seeded — the
 * transcripts above are what the Historian actually searches until a workspace
 * is connected.
 */
async function seedSlackScopes(orgId: number): Promise<void> {
  await raw`DELETE FROM mining_scopes WHERE org_id = ${orgId} AND added_by = 'seed'`;

  for (const channel of ["C_BILLING", "C_PLATFORM", "C_INCIDENTS", "C_DATA_ENG"]) {
    await raw`
      INSERT INTO mining_scopes (org_id, connector, scope_value, added_by)
      VALUES (${orgId}, 'slack', ${channel}, 'seed')
      ON CONFLICT DO NOTHING
    `;
  }
  log("slack: 4 channels in mining scope");
}

/**
 * A failed workflow execution, already diagnosed.
 *
 * Seeded with its diagnosis rather than left for the pipeline, so the Slack
 * message and the detail page have something to render before anyone connects
 * n8n. The cause names the migration that is genuinely in `changes` above,
 * which is what makes clicking through from the alert land somewhere real.
 */
async function seedWorkflowFailure(orgId: number): Promise<void> {
  const [instance] = (await raw`
    SELECT id FROM connector_instances WHERE org_id = ${orgId} ORDER BY id LIMIT 1
  `) as unknown as Array<{ id: number }>;
  if (!instance) return;

  await raw`DELETE FROM n8n_execution_failures WHERE org_id = ${orgId} AND execution_id >= 900000`;

  const [node] = (await raw`
    SELECT id FROM nodes WHERE org_id = ${orgId} AND name = 'public.eu_vat_report' LIMIT 1
  `) as unknown as Array<{ id: number }>;

  const diagnosis = {
    impact: {
      count: 3,
      top: [{ name: "public.eu_vat_report", kind: "report", hops: 1 }],
    },
    cause:
      "The migration in db/migrations/0031_drop_invoices_vat_rate.sql removed invoices.vat_rate, which this workflow reads directly to produce the quarterly filing.",
    recommendation:
      "Restore invoices.vat_rate from the migration rather than re-adding it with a default — a default writes a rate that was never charged. PR #482 already does this.",
    confidence: 0.88,
    evidence: [
      { source: "error", detail: 'column "vat_rate" does not exist' },
      {
        source: "change",
        detail: "7f3e1a9c drop the vat_rate column now that Avalara returns it live",
      },
      {
        source: "document",
        detail: "Billing Schema Review: removing the column breaks a regulatory filing",
      },
    ],
    windowsSearched: 1,
    searchReach: "since the release checkpoint 20 hours ago",
    schemaChangeSuspected: true,
  };

  await raw`
    INSERT INTO n8n_execution_failures
      (org_id, instance_id, execution_id, workflow_id, workflow_name, node_id, mode,
       failed_node, error_message, started_at, stopped_at, detect_path, detected_at,
       diagnosis_state, diagnosis, diagnosed_at)
    VALUES (${orgId}, ${instance.id}, 900001, 'wf-quarterly-vat', 'Quarterly VAT filing',
            ${node?.id ?? null}, 'trigger', 'Postgres · read invoices',
            'column "vat_rate" does not exist',
            ${hoursAgo(13).toISOString()}::timestamptz,
            ${hoursAgo(13).toISOString()}::timestamptz,
            'poll', ${hoursAgo(13).toISOString()}::timestamptz,
            'diagnosed', ${JSON.stringify(diagnosis)}::jsonb,
            ${hoursAgo(13).toISOString()}::timestamptz)
  `;
  log("workflow: one failed execution with a full diagnosis");
}

async function main(): Promise<void> {
  const [org] = (await raw`
    SELECT id FROM organizations WHERE slug = ${ORG_SLUG} LIMIT 1
  `) as unknown as Array<{ id: number }>;
  if (!org) {
    log(`No organisation with slug ${ORG_SLUG}. Run \`pnpm seed\` first.`);
    return;
  }
  log(`seeding demo data into org #${org.id}`);

  await seedDocuments(org.id);
  const repoId = await seedChanges(org.id);
  await seedCheckpoints(org.id, repoId);
  await seedRationale(org.id);
  await seedMetrics(org.id);
  await seedIncident(org.id);
  await seedSlackScopes(org.id);
  await seedWorkflowFailure(org.id);

  log("");
  log("Done. The story: a VAT column two meetings decided to keep, a migration");
  log("that dropped it, the workflow that broke, and the PR that would fix it.");
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(closePools);

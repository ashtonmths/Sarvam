import * as schema from "@sadhak/shared/schema";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { config } from "./config.js";

/**
 * Connection budget on the single VPS Postgres (max_connections = 100):
 *
 *   sadhak-api   10   request path — small, fast, impatient (10s statements)
 *   sadhak-jobs   5   crawls and agents — fewer, patient (300s statements)
 *   migrator      1   boot only, holds an advisory lock
 *   n8n         ~10   its own pool
 *   headroom    ~10   psql, pg_dump, incident triage
 *   ────────────────
 *   ~36 of 100        room to scale the worker out without touching Postgres
 *
 * Triage during an incident:
 *   SELECT application_name, count(*) FROM pg_stat_activity GROUP BY 1;
 *
 * Splitting the pools is what stops a long crawl from starving the gate path,
 * which is the one route that must answer in tens of milliseconds.
 */

/**
 * `TimeZone: UTC` is pinned, not assumed.
 *
 * The daily rollup compares a `timestamptz` against a `date`, and Postgres
 * resolves that by promoting the date using the *session* time zone — while
 * the label written alongside it is computed in UTC. Unpinned, that session
 * zone is whatever the server was initdb'd with, so the bucket boundary and
 * the bucket's own name silently disagree by the server's offset. It happens
 * to be UTC on the bundled pgvector image and stops being UTC on most managed
 * Postgres, which is the worst way for this to be true.
 *
 * The schema comment on metric_rollups.day already says the day must be UTC.
 * This is what makes that a property of the system rather than a wish.
 */
const CONNECTION = { TimeZone: "UTC" } as const;

/** Request path. */
export const sql = postgres(config.DATABASE_URL, {
  max: config.PG_POOL_WEB,
  connection: {
    ...CONNECTION,
    application_name: "sadhak-api",
    statement_timeout: 10_000,
  },
});

/** Jobs and crawls. */
export const sqlJobs = postgres(config.DATABASE_URL, {
  max: config.PG_POOL_JOBS,
  idle_timeout: 30,
  connection: {
    ...CONNECTION,
    application_name: "sadhak-jobs",
    statement_timeout: 300_000,
  },
});

export const db = drizzle(sql, { schema });
export const dbJobs = drizzle(sqlJobs, { schema });

export type Db = typeof db;

export async function closePools(): Promise<void> {
  await Promise.allSettled([sql.end({ timeout: 5 }), sqlJobs.end({ timeout: 5 })]);
}

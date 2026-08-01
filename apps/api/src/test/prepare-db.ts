import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

/**
 * Builds the integration database from nothing.
 *
 * Run as its own process rather than inline in vitest's globalSetup, because
 * that file is loaded from the repository root where the API's dependencies do
 * not resolve. Spawning it here also means the integration suite migrates
 * through exactly the same drizzle migrator production boots with, so a
 * migration that would fail on a fresh database fails here first.
 */

// Raw process.env rather than config.ts, which is a deliberate exception
// recorded in biome.json: importing config.ts validates DATABASE_URL and exits
// the process when it does not resolve — and the database it points at is the
// one this script exists to create.
const ADMIN_URL =
  process.env.INTEGRATION_ADMIN_URL ?? "postgres://sadhak:sadhak@localhost:5432/postgres";
const TEST_DB = process.env.INTEGRATION_DB ?? "sadhak_test";

async function main(): Promise<void> {
  const admin = postgres(ADMIN_URL, { max: 1, onnotice: () => undefined });
  try {
    // Dropped and recreated, never reused: a suite that inherits whatever the
    // last run left behind fails in ways that depend on run order.
    await admin.unsafe(`DROP DATABASE IF EXISTS "${TEST_DB}" WITH (FORCE)`);
    await admin.unsafe(`CREATE DATABASE "${TEST_DB}"`);
  } finally {
    await admin.end({ timeout: 5 });
  }

  const url = new URL(ADMIN_URL);
  url.pathname = `/${TEST_DB}`;

  const sql = postgres(url.toString(), { max: 1, onnotice: () => undefined });
  try {
    await sql`CREATE EXTENSION IF NOT EXISTS vector`;
    await migrate(drizzle(sql), { migrationsFolder: "../../db/migrations" });
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((error: unknown) => {
  console.error("integration database setup failed:", error);
  process.exit(1);
});

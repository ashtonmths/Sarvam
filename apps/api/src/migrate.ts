import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { config } from "./config.js";

/**
 * Boot migration runner. An advisory lock serializes two replicas booting at
 * the same second instead of letting them race DDL; `lock_timeout` makes a
 * stuck migration fail loudly rather than queue behind traffic.
 */

/** "sadhak" in hex-ish. Any stable constant works; it just has to be ours. */
const LOCK_KEY = 0x5adba3;

async function main(): Promise<void> {
  const sql = postgres(config.DATABASE_URL, {
    max: 1,
    connection: { application_name: "sadhak-migrate", lock_timeout: 10_000 },
  });

  try {
    await sql`SELECT pg_advisory_lock(${LOCK_KEY})`;
    await migrate(drizzle(sql), { migrationsFolder: "../../db/migrations" });
    console.log("migrations applied");
  } finally {
    await sql`SELECT pg_advisory_unlock(${LOCK_KEY})`.catch(() => undefined);
    await sql.end({ timeout: 5 });
  }
}

main().catch((error: unknown) => {
  console.error("migration failed:", error);
  process.exit(1);
});

import { defineConfig } from "vitest/config";

/**
 * Integration tier: the tests that need a real Postgres.
 *
 * Split from the unit config rather than gated by a skip-if-no-database flag,
 * because a suite that silently passes when the database is missing is a suite
 * that stops running the day CI's service container is misconfigured, and
 * nobody notices for a month.
 */

const TEST_DB = process.env.INTEGRATION_DB ?? "sadhak_test";
const ADMIN_URL =
  process.env.INTEGRATION_ADMIN_URL ?? "postgres://sadhak:sadhak@localhost:5432/postgres";

const databaseUrl = (() => {
  const url = new URL(ADMIN_URL);
  url.pathname = `/${TEST_DB}`;
  return url.toString();
})();

export default defineConfig({
  test: {
    include: ["apps/**/*.int.test.ts", "packages/**/*.int.test.ts"],
    globalSetup: ["apps/api/src/test/integration-setup.ts"],
    // One process: these tests share a database, and parallel workers running
    // DDL and truncation against the same tables produce failures that belong
    // to the runner rather than to the code.
    fileParallelism: false,
    env: {
      NODE_ENV: "test",
      DATABASE_URL: databaseUrl,
      LOG_LEVEL: "silent",
      // A throwaway vault key. Set explicitly rather than inherited from a
      // developer's .env, so the vault suites run identically in CI — where
      // there is no .env at all — and a missing key fails as a missing key
      // rather than as a mysterious decrypt error.
      CREDENTIAL_MASTER_KEY: "v1:dGVzdC1vbmx5LWtleS1ub3QtYS1yZWFsLXNlY3JldC0=",
      JOBS_ENABLED: "false",
      RATE_LIMIT_ENABLED: "true",
    },
  },
});

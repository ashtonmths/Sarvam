import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

/**
 * Creates and migrates the integration database once per run.
 *
 * A real Postgres rather than a mock, because the things worth testing at this
 * tier are exactly the ones a mock would invent: `ON CONFLICT … RETURNING`
 * under real concurrency, composite foreign keys refusing a cross-org edge,
 * and the recursive CTE the whole verdict rests on. A stubbed driver only
 * proves the stub does what it was told.
 *
 * The work happens in a child process inside `apps/api`, because vitest loads
 * this file from the repository root where the API's dependencies do not
 * resolve.
 */
export async function setup(): Promise<void> {
  await run(
    "pnpm",
    ["--filter", "@sadhak/api", "exec", "tsx", "src/test/prepare-db.ts"],
    {
      env: process.env,
    },
  );
}

export async function teardown(): Promise<void> {
  // Deliberately left in place. When a test fails, the state that produced the
  // failure is the most useful thing in the room; the next run drops it.
}

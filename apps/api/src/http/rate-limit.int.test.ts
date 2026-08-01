import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closePools, sql } from "../db.js";
import { hitShared, purgeStaleCounters } from "./rate-limit.js";

/**
 * The shared tier against a real Postgres. The behaviour that matters is the
 * one a mock cannot show: that `INSERT … ON CONFLICT DO UPDATE … RETURNING`
 * gives every concurrent caller a distinct, monotonically increasing count, so
 * two requests arriving together cannot both believe they are under the limit.
 */

beforeEach(async () => {
  await sql`TRUNCATE rate_counters`;
});

afterAll(async () => {
  await closePools();
});

describe("hitShared", () => {
  it("allows up to the limit and denies past it", async () => {
    const bucket = "key:1";

    expect((await hitShared(bucket, 3)).allowed).toBe(true);
    expect((await hitShared(bucket, 3)).allowed).toBe(true);
    expect((await hitShared(bucket, 3)).allowed).toBe(true);
    expect((await hitShared(bucket, 3)).allowed).toBe(false);
  });

  it("counts buckets independently", async () => {
    expect((await hitShared("key:1", 1)).allowed).toBe(true);
    expect((await hitShared("key:2", 1)).allowed).toBe(true);
    expect((await hitShared("key:1", 1)).allowed).toBe(false);
  });

  it("gives concurrent callers distinct counts", async () => {
    // Twenty at once against a limit of ten: exactly ten may pass. If the
    // increment and the read were separate statements, more would.
    const results = await Promise.all(
      Array.from({ length: 20 }, () => hitShared("org:99", 10)),
    );

    expect(results.filter((r) => r.allowed)).toHaveLength(10);
    expect(results.filter((r) => !r.allowed)).toHaveLength(10);
  });

  it("separates windows by time", async () => {
    const now = Date.UTC(2026, 6, 26, 12, 0, 0);
    const nextWindow = now + 60_000;

    expect((await hitShared("key:7", 1, now)).allowed).toBe(true);
    expect((await hitShared("key:7", 1, now)).allowed).toBe(false);
    expect((await hitShared("key:7", 1, nextWindow)).allowed).toBe(true);
  });

  it("reports seconds remaining in the window", async () => {
    const atThirtySeconds = Date.UTC(2026, 6, 26, 12, 0, 30);

    const decision = await hitShared("key:8", 1, atThirtySeconds);

    expect(decision.retryAfterSeconds).toBe(30);
  });

  it("writes one row per bucket and window, not one per request", async () => {
    for (let i = 0; i < 5; i++) await hitShared("key:9", 100);

    const rows = await sql<{ count: number }[]>`
      SELECT count FROM rate_counters WHERE bucket = 'key:9'
    `;

    expect(rows).toHaveLength(1);
    expect(rows[0]?.count).toBe(5);
  });
});

describe("purgeStaleCounters", () => {
  it("deletes closed windows and leaves the current one", async () => {
    await sql`
      INSERT INTO rate_counters (bucket, window_start, count)
      VALUES ('key:old', now() - interval '2 hours', 5)
    `;
    await hitShared("key:current", 100);

    const deleted = await purgeStaleCounters();

    expect(deleted).toBe(1);
    const remaining = await sql<{ bucket: string }[]>`
      SELECT bucket FROM rate_counters
    `;
    expect(remaining.map((r) => r.bucket)).toEqual(["key:current"]);
  });
});

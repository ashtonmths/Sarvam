import { performance } from "node:perf_hooks";

/**
 * The gate's wire-path budget.
 *
 * `bench-blast.ts` measures the engine in-process. What a customer experiences
 * is the engine wrapped in Hono, auth middleware, rate limiting, JSON
 * serialization and a proxy — and the promise is about that path, not the
 * function call inside it. This measures the path.
 *
 * Deliberately dependency-free: k6 is another runtime to install before anyone
 * can check a number, and even undici would tie this to one workspace. Node's
 * global fetch runs it from anywhere, which is the difference between a budget
 * that gets checked and one that gets deferred.
 *
 *   RATE_LIMIT_ENABLED=false pnpm --filter @sadhak/api dev
 *   node tests/load/gate.mjs
 *
 * **Run the API with rate limiting off.** This measures how fast the gate can
 * answer, and the limiter is a deliberate ceiling rather than a property of
 * that. Leaving it on would measure the limiter: a single org is budgeted
 * 1,200 requests a minute — twenty a second — so a run at several hundred a
 * second reports 429s and a flattering latency for requests that were never
 * answered.
 *
 * Both numbers are real and they answer different questions. "How fast is a
 * verdict" is below. "How many verdicts may one org buy per minute" is
 * RATE_LIMIT_ORG_PER_MIN, and it is a product decision, not a limit of the
 * engine.
 */

const BASE = process.env.LOAD_BASE_URL ?? "http://localhost:3001";
const CONCURRENCY = Number(process.env.CONCURRENCY ?? 20);
const DURATION_MS = Number(process.env.DURATION_MS ?? 10_000);

/**
 * Plan 8's budget for the enforced gate path. A breach exits non-zero, so the
 * number is a gate rather than a report nobody reads.
 */
const P99_BUDGET_MS = Number(process.env.P99_BUDGET_MS ?? 75);

const CHANGE = {
  target: "field",
  operation: "delete",
  connector: "postgres",
  externalId: "1/db/demo_billing/column/public.invoices.vat_rate",
};

async function signIn() {
  const res = await fetch(`${BASE}/api/auth/signin`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: process.env.LOAD_EMAIL ?? "demo@sadhak.online",
      password: process.env.LOAD_PASSWORD ?? "sadhak-demo-2026",
    }),
  });
  if (res.status !== 200) throw new Error(`sign in failed with ${res.status}`);

  const raw = res.headers.getSetCookie?.() ?? [];
  if (raw.length === 0) throw new Error("sign in returned no session cookie");
  return raw.map((c) => c.split(";")[0]).join("; ");
}

function percentile(sorted, q) {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
}

async function main() {
  const cookie = await signIn();
  const latencies = [];
  const statuses = new Map();
  const deadline = performance.now() + DURATION_MS;

  async function worker() {
    while (performance.now() < deadline) {
      const started = performance.now();
      const res = await fetch(`${BASE}/api/verdicts`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify(CHANGE),
      });
      // Drain the body: leaving it unread keeps the socket busy and measures
      // our own back-pressure rather than the server's latency.
      await res.arrayBuffer();
      latencies.push(performance.now() - started);
      statuses.set(res.status, (statuses.get(res.status) ?? 0) + 1);
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

  latencies.sort((a, b) => a - b);
  const seconds = DURATION_MS / 1000;
  const p50 = percentile(latencies, 0.5);
  const p95 = percentile(latencies, 0.95);
  const p99 = percentile(latencies, 0.99);

  console.log(
    `requests    ${latencies.length} over ${seconds}s at ${CONCURRENCY} concurrent`,
  );
  console.log(`throughput  ${(latencies.length / seconds).toFixed(0)}/s`);
  console.log(`p50         ${p50.toFixed(1)}ms`);
  console.log(`p95         ${p95.toFixed(1)}ms`);
  console.log(`p99         ${p99.toFixed(1)}ms   (budget ${P99_BUDGET_MS}ms)`);
  console.log(`statuses    ${[...statuses].map(([s, n]) => `${s}:${n}`).join(" ")}`);

  /**
   * A non-200 is a failed run even at a good latency. A gate that answers 429
   * quickly is not answering — and a load test that reported a fast p99 while
   * every request was rejected would be worse than no load test.
   */
  const nonOk = [...statuses].filter(([status]) => status !== 200);
  if (nonOk.length > 0) {
    console.error(
      `FAIL: non-200 responses: ${nonOk.map(([s, n]) => `${s}×${n}`).join(", ")}`,
    );
    process.exit(1);
  }

  if (p99 > P99_BUDGET_MS) {
    console.error(`FAIL: p99 ${p99.toFixed(1)}ms exceeds the ${P99_BUDGET_MS}ms budget`);
    process.exit(1);
  }

  console.log("PASS");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

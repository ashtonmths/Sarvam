import { defineConfig, devices } from "@playwright/test";

/**
 * The e2e tier: the product spine, through a real browser, against a real API
 * and a real Postgres.
 *
 * Deliberately few tests. E2E is the slowest and flakiest layer of the pyramid,
 * so it covers the paths where a break would be invisible to every layer below
 * — a route that renders but never fetches, a session cookie the browser
 * rejects, a verdict that returns 200 and paints nothing. Anything a unit or
 * integration test can prove belongs there instead.
 *
 * The stack is assumed running (`pnpm dev` plus a seeded database). Starting it
 * here would double as an orchestration layer nobody debugs until it breaks.
 */
export default defineConfig({
  testDir: "e2e",
  // One worker: the tests share one seeded org, and parallel runs mutating the
  // same graph produce failures that belong to the runner rather than the code.
  workers: 1,
  fullyParallel: false,
  // A retry hides flake rather than fixing it, and a flaky e2e test is worse
  // than no e2e test — it teaches people to re-run the build.
  retries: 0,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI ? "list" : "line",
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:3000",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    // Authenticate once. Signing in per test tripped our own auth limiter,
    // which is the correct behaviour from the limiter and the wrong shape for
    // the suite.
    { name: "setup", testMatch: /auth\.setup\.ts/ },
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"], storageState: "e2e/.auth/session.json" },
      dependencies: ["setup"],
    },
  ],
});

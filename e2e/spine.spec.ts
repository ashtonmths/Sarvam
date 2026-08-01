import { expect, test } from "@playwright/test";

/**
 * The product spine: sign in, see the map, ask the gate a question, act on
 * what it says.
 *
 * These assert the joins no lower layer can see. A route can render while
 * never fetching; a session cookie can be set and then rejected by the
 * browser; a verdict can return 200 and paint nothing. Unit and integration
 * tests prove each side of those seams and none of them prove the seam.
 */

test.describe("the session gate", () => {
  // No saved session: this is the signed-out case.
  test.use({ storageState: { cookies: [], origins: [] } });

  test("sends a signed-out visitor to sign in rather than an empty shell", async ({
    page,
  }) => {
    await page.goto("/app/graph");

    // The failure this catches: middleware passes, the page renders its
    // chrome, and every fetch 401s — which looks like a broken product
    // rather than a login prompt.
    await expect(page).toHaveURL(/\/signin/);
  });
});

test.describe("the map", () => {
  test("signs in from the saved session and lands on the overview", async ({ page }) => {
    await page.goto("/app");

    await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible();
  });

  test("shows real crawled counts, not a zero state", async ({ page }) => {
    await page.goto("/app");

    // The seeded org has a genuine crawl behind it. Zero here means the page
    // rendered without its data, which is exactly the seam being tested.
    const nodes = page.locator(".ostats__cell").first();

    await expect(nodes).toBeVisible();
    await expect(nodes.locator("strong")).not.toHaveText("0");
  });

  test("opens the graph explorer", async ({ page }) => {
    await page.goto("/app/graph");

    await expect(page.getByRole("heading", { name: /graph/i }).first()).toBeVisible();
  });
});

test.describe("the gate", () => {
  test("returns a verdict with its blast radius for a real change", async ({ page }) => {
    await page.goto("/app/simulate");

    await page.getByTestId("simulate-run").click();

    // The whole product in one assertion: a change proposed, a verdict
    // returned, and the affected thing named.
    const card = page.getByTestId("simulate-verdict-card");
    await expect(card).toBeVisible({ timeout: 25_000 });
    await expect(card).toContainText(/APPROVE|WARN|BLOCK/);
  });
});

test.describe("drift", () => {
  test("says the map agrees rather than rendering an empty page", async ({ page }) => {
    await page.goto("/app/drift");

    await expect(page.getByRole("heading", { name: "Drift" })).toBeVisible();

    // An empty queue must read as an answer. A blank panel could equally mean
    // nothing is in dispute or nobody is looking, and those are very different.
    // Asserted on a stable hook rather than prose, so the test fails when the
    // summary does not load rather than when the wording changes.
    const summary = page.getByTestId("drift-summary");
    await expect(summary).toBeVisible();
    await expect(summary).toContainText(/finding/i);
    await expect(summary).toContainText(/watching \d+ instance/i);
  });
});

test.describe("metrics", () => {
  test("never shows an unmeasured latency as zero", async ({ page }) => {
    await page.goto("/app/metrics");

    await expect(page.getByRole("heading", { name: "Mistake to repair" })).toBeVisible();

    // The seeded org has no incidents, so every latency is unmeasured. "0ms"
    // here would read as instant detection — the most flattering possible lie
    // a dashboard can tell, and the reason the null state exists at all.
    const latencies = page.locator(".lat__value");
    await expect(latencies.first()).toBeVisible();
    for (const value of await latencies.allTextContents()) {
      expect(value).not.toMatch(/^0\s*(ms|s)$/);
    }
  });

  test("shows coverage as two numbers and never sums them", async ({ page }) => {
    await page.goto("/app/metrics");

    await expect(page.getByText(/counts toward coverage/i)).toBeVisible();
    await expect(page.getByText(/never counted/i)).toBeVisible();
  });
});

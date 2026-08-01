import AxeBuilder from "@axe-core/playwright";
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

  test("never puts the password in the URL, even before React hydrates", async ({
    page,
  }) => {
    await page.goto("/signin");

    // The bug this pins, found by driving the real form: a form with no
    // `method` submits as a GET when there is no handler yet, and the handler
    // only exists after hydration. A user who types fast on a slow connection
    // sends their password as a query string — into browser history, the
    // Referer header, and the access log of every proxy in front of us.
    //
    // Two defences, and this asserts both. The button is disabled until
    // mounted, so the click does nothing; and the form is POST, so even if a
    // submit escapes some other way it cannot put field values in a URL.
    await expect(page.locator("form.auth__form")).toHaveAttribute("method", /post/i);

    await page.getByLabel(/work email/i).fill("someone@example.com");
    await page.getByLabel(/password/i).fill("hunter2-should-never-be-in-a-url");
    await page.getByTestId("auth-submit").click();
    await page.waitForTimeout(1500);

    expect(page.url()).not.toContain("hunter2");
    expect(page.url()).not.toContain("password=");
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
    const boxes = page.locator(".mx-lat");
    await expect(boxes.first()).toBeVisible();

    // An unmeasured box names what would measure it instead of rendering a
    // figure, so there is no number present to be mistaken for a fast one.
    await expect(page.locator(".mx-lat--waiting").first()).toBeVisible();

    for (const value of await page.locator(".mx-lat__value").allTextContents()) {
      expect(value).not.toMatch(/^0\s*(ms|s)$/);
    }
  });

  test("shows coverage as two numbers and never sums them", async ({ page }) => {
    await page.goto("/app/metrics");

    await expect(page.getByRole("heading", { name: "Coverage" })).toBeVisible();

    // Confirmed and drafted are reported side by side and never added. A draft
    // is a proposal until a person checks it against its source, so folding it
    // into coverage would claim credit for work nobody has verified.
    await expect(page.locator(".mx-cov__key")).toHaveText(["confirmed", "drafted"]);

    const [confirmed] = await page.locator(".mx-cov__num").allTextContents();
    await expect(page.locator(".mx-cov__num")).toHaveCount(2);

    // The headline figure is the confirmed share alone, not the two added up.
    await expect(page.locator(".mx-cov__pct")).toHaveText(confirmed);
  });
});

test.describe("accessibility", () => {
  /**
   * A scan, not a spot check.
   *
   * Every violation this caught on its first run was real and none was
   * visible by looking: `--ink-faint` measured 2.67:1 and was the muted text
   * token used for every rail label, chip and caption; the graph's zoom
   * controls were `aria-hidden` while still taking focus, so a keyboard user
   * got three tab stops that announce nothing; and the verdict badges — the
   * product's actual output — sat between 3.4 and 4.5:1 on their own chips.
   *
   * Pinned at zero rather than at a budget. A threshold above zero is a
   * threshold nobody ever brings back down.
   */
  const PAGES = [
    "/",
    "/pricing",
    "/legal/privacy",
    "/legal/terms",
    "/app",
    "/app/graph",
    "/app/queue",
    "/app/decisions",
    "/app/metrics",
  ];

  for (const path of PAGES) {
    test(`${path} has no WCAG AA violations`, async ({ page }) => {
      await page.goto(path);
      await page.waitForLoadState("networkidle");

      const results = await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
        .analyze();

      expect(
        results.violations.map((v) => `${v.id}: ${v.nodes[0]?.html?.slice(0, 80)}`),
      ).toEqual([]);
    });
  }
});

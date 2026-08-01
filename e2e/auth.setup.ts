import { expect, test as setup } from "@playwright/test";

/**
 * Signs in once for the whole run and saves the session.
 *
 * The first version of this suite signed in inside every `beforeEach`, and the
 * run failed — throttled by our own auth limiter, which allows 10 requests a
 * minute because that is where guessing a password is worth someone's time.
 * Raising the limit for tests would have been the wrong fix twice over: it
 * weakens a real control, and it hides that a signed-in user is supposed to
 * reuse a session rather than re-authenticate on every page.
 */

const FILE = "e2e/.auth/session.json";

setup("authenticate", async ({ page }) => {
  await page.goto("/signin");
  await page.getByLabel(/email/i).fill("demo@sadhak.online");
  await page.getByLabel(/password/i).fill("sadhak-demo-2026");
  await page.getByRole("button", { name: /sign in/i }).click();

  await page.waitForURL(/\/app(\/|$)/, { timeout: 20_000 });
  await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible();

  await page.context().storageState({ path: FILE });
});

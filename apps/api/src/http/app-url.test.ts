import { describe, expect, it } from "vitest";
import { firstCrawlComplete } from "../email/templates.js";
import { appUrl } from "./app-url.js";

/**
 * Deep links are built from configuration, not typed out.
 *
 * Every link in a Slack alert and every link in an email was written as a
 * literal `https://sadhak.online/...`. On this deployment that is right; on a
 * laptop, a preview environment, or anyone else's install it is a link into
 * somebody else's product — and nothing fails. The message sends, the button
 * renders, and it goes to the wrong place.
 *
 * Asserted through a rendered email as well as the helper, because the helper
 * being correct was never the problem.
 */
describe("appUrl", () => {
  it("builds on the first configured web origin", () => {
    expect(appUrl("/app/ci/7")).toBe("http://localhost:3000/app/ci/7");
  });

  it("does not double the slash when the path already has one", () => {
    expect(appUrl("app/ci/7")).toBe(appUrl("/app/ci/7"));
  });

  it("renders emails against the configured origin, not a baked-in host", () => {
    const mail = firstCrawlComplete({
      orgName: "Acme",
      nodes: 13,
      edges: 17,
      topNodes: ["public.invoices"],
    });
    expect(mail.html).not.toContain("sadhak.online");
    expect(mail.text).not.toContain("sadhak.online");
    expect(mail.text).toContain("http://localhost:3000/app/simulate");
  });
});

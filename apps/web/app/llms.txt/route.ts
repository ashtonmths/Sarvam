import { docsTree } from "../../lib/docs";

/**
 * An index of the docs, for something that reads rather than looks.
 *
 * Half this product's audience is an agent: Mode 2 exists so an AI can ask the
 * gate before it mutates something. Making that agent scrape HTML to learn how
 * to integrate would be a strange way to treat the customer we built the mode
 * for. The convention is llms.txt; the raw markdown behind each link is served
 * at /docs/raw/<slug>.
 */
export const dynamic = "force-static";

export function GET(): Response {
  const pages = docsTree();

  const body = `# Sadhak

> A living dependency graph of your automations, data and APIs, fused with the
> human reasoning behind every connection, gating the changes that would break
> them. Verdicts are deterministic: the same change against the same graph
> returns the same answer, with no model in the path.

## Docs

${pages
  .map(
    (page) => `- [${page.title}](https://sadhak.online${page.href}): ${page.description}`,
  )
  .join("\n")}

## Raw markdown

Every page above is also served as its markdown source, which is usually what
you want:

${pages
  .map(
    (page) =>
      `- https://sadhak.online/docs/raw${page.href === "/docs" ? "/index" : page.href.replace("/docs", "")}`,
  )
  .join("\n")}

## API

- OpenAPI: https://api.sadhak.online/openapi.json
- Interactive reference: https://api.sadhak.online/reference
- MCP endpoint: https://api.sadhak.online/mcp

## The one thing worth knowing before integrating

BLOCK means the mutation is never forwarded. The evidence chain comes back with
it, so the right response is to propose a different change, not to retry.
`;

  return new Response(body, {
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

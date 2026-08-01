import { describe, expect, it } from "vitest";
import { openapiDocument } from "./openapi.js";

/**
 * Every authenticated route a caller can reach must appear in the spec.
 *
 * `check:openapi` compares the committed file against what `openapi.ts`
 * declares, so it catches *drift* and is blind to *omission* — five routes were
 * added across two features and CI stayed green while documenting none of them.
 * The spec is the contract an agent builder writes against, and a route missing
 * from it is a route nobody outside this repository knows exists.
 *
 * This list is deliberately explicit rather than derived from the Hono router.
 * Reading routes off the app at test time would make the assertion tautological
 * — it would compare the router to itself. Adding a route means adding a line
 * here, which is the point: it is a decision, not an accident.
 */
const PUBLISHED_ROUTES = [
  "/api/auth/signup",
  "/api/auth/signin",
  "/api/auth/me",
  "/api/verdicts",
  "/api/verdicts/{id}",
  "/api/verdicts/{id}/explanation",
  "/api/graph/nodes",
  "/api/graph/edges",
  "/api/graph/stats",
  "/api/graph/unresolved",
  "/api/rationale",
  "/api/incidents",
  "/api/audit",
  "/api/documents",
  "/api/ask",
  "/api/ci",
  "/api/ci/{id}",
  "/api/repos",
  "/api/checkpoints",
  "/api/investigate",
  "/api/changes",
  "/api/org/export",
  "/api/org",
];

describe("openapi coverage", () => {
  const paths = Object.keys(openapiDocument().paths ?? {});

  it("documents every route the product publishes", () => {
    const missing = PUBLISHED_ROUTES.filter((route) => !paths.includes(route));
    expect(missing).toEqual([]);
  });

  it("documents nothing that is not published", () => {
    // The inverse matters too: a path left behind after a route was removed
    // sends a caller at something that answers 404.
    const extra = paths.filter((path) => !PUBLISHED_ROUTES.includes(path));
    expect(extra).toEqual([]);
  });

  it("gives every operation a summary and a tag", () => {
    for (const [path, item] of Object.entries(openapiDocument().paths ?? {})) {
      for (const [method, operation] of Object.entries(
        item as Record<string, { summary?: string; tags?: string[] }>,
      )) {
        expect(operation.summary, `${method} ${path} has no summary`).toBeTruthy();
        expect(operation.tags?.length, `${method} ${path} has no tag`).toBeTruthy();
      }
    }
  });
});

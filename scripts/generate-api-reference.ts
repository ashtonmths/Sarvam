import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Generates the API reference from the route files.
 *
 * Hand-written endpoint documentation drifts the first time someone adds a
 * route in a hurry, and a reference that lies is worse than none — a caller
 * builds against it and finds out at runtime. So the routes are read from the
 * source, and `--check` fails CI when the committed page no longer matches,
 * which is the same shape as `check:env`.
 *
 * Deliberately not OpenAPI. The routes validate with Zod at the handler rather
 * than through a schema-first router, so a generated spec would be a second
 * description of the request shape that could disagree with the first. This
 * generates what can be read with certainty — method, path, capability — and
 * links to the source for the rest.
 */

const root = new URL("..", import.meta.url);
const OUT = "docs/API.md";

interface Route {
  method: string;
  path: string;
  capability: string | null;
  file: string;
}

/** Which group a route file mounts under. Mirrors index.ts. */
const MOUNTS: Record<string, string> = {
  "auth.ts": "/api/auth",
  "webhooks.ts": "",
  "mcp.ts": "",
};

function routesIn(file: string): Route[] {
  const source = readFileSync(
    fileURLToPath(new URL(`apps/api/src/routes/${file}`, root)),
    "utf8",
  );

  const found: Route[] = [];
  const pattern =
    /(\w+Routes)\.(get|post|patch|put|delete)\(\s*"([^"]+)"\s*(?:,\s*requireCapability\("([^"]+)"\))?/g;

  for (const match of source.matchAll(pattern)) {
    const [, , method, path, capability] = match;
    if (!method || !path) continue;

    const prefix = MOUNTS[file] ?? "/api";
    found.push({
      method: method.toUpperCase(),
      path: `${prefix}${path}`,
      capability: capability ?? null,
      file,
    });
  }

  return found;
}

function render(routes: Route[]): string {
  const byFile = new Map<string, Route[]>();
  for (const route of routes) {
    byFile.set(route.file, [...(byFile.get(route.file) ?? []), route]);
  }

  const sections = [...byFile.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([file, group]) => {
      const rows = group
        .sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method))
        .map(
          (route) =>
            `| \`${route.method}\` | \`${route.path}\` | ${
              route.capability ? `\`${route.capability}\`` : "—"
            } |`,
        )
        .join("\n");

      return [
        `### ${file.replace(".ts", "")}`,
        "",
        "| Method | Path | Capability |",
        "|---|---|---|",
        rows,
        "",
        `Source: \`apps/api/src/routes/${file}\``,
        "",
      ].join("\n");
    });

  return `# API reference

**Generated from the route files.** Run \`pnpm docs:api\` to regenerate; CI
fails if this page and the routes disagree. Hand-editing it will be overwritten,
and a reference that lies is worse than none — a caller builds against it and
finds out at runtime.

${routes.length} routes.

## How to call it

Two credentials, and which one you hold decides what you may do.

**Session cookie** — what the web app uses. \`POST /api/auth/signin\` with an
email and password sets it.

**API key** — what an agent or a script uses. Send it as \`X-API-Key\` or
\`Authorization: Bearer\`. A key carries capabilities, and it can never hold
more than the person who created it.

\`\`\`sh
curl -s -X POST https://api.sadhak.online/api/verdicts \\
  -H "X-API-Key: sadhak_…" -H 'content-type: application/json' \\
  -d '{"target":"field","operation":"delete","connector":"postgres","externalId":"…"}'
\`\`\`

Every org-scoped route also answers at \`/api/orgs/:orgId/…\`. The \`:orgId\` is
*asserted* against the org your credential resolved to — a mismatch is a **404,
not a 403**, so a wrong org id is indistinguishable from one that does not
exist.

## Conventions

**Errors** are RFC 9457 problem details, served as
\`application/problem+json\`, and every response carries \`X-Request-Id\`:

\`\`\`jsonc
{
  "type": "https://sadhak.online/errors/validation",
  "title": "Invalid request",
  "status": 400,
  "detail": "operation must be one of delete|rename|retype|disable|revoke",
  "instance": "/api/verdicts",
  "requestId": "8f14e45f-…"
}
\`\`\`

**Lists** return \`{ items, nextCursor }\`. \`?limit=\` defaults to 50 and caps
at 200; outside that range is a 400, never a silent clamp. Cursors are opaque,
and a tampered one is a 400, never a 500.

**Rate limits** answer 429 with \`Retry-After\`. Budgets are per key (300/min)
and per org (1,200/min); \`GET /health\` is never limited.

## The two capabilities worth understanding

\`gate:invoke\` asks the gate for a verdict. \`gate:execute\` forwards a change
through it. They are separate on purpose: **an agent that may ask is not
necessarily an agent that may act.**

## Endpoints

${sections.join("\n")}
## Not in this table

\`GET /healthz\` (liveness), \`GET /readyz\` (readiness) and \`GET /metrics\`
(Prometheus, behind \`METRICS_TOKEN\`) are mounted directly in
\`apps/api/src/index.ts\`. See [OBSERVABILITY.md](./OBSERVABILITY.md).
`;
}

const files = readdirSync(fileURLToPath(new URL("apps/api/src/routes", root)))
  .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
  .sort();

const routes = files.flatMap(routesIn);
const rendered = render(routes);
const outPath = fileURLToPath(new URL(OUT, root));

if (process.argv.includes("--check")) {
  let current = "";
  try {
    current = readFileSync(outPath, "utf8");
  } catch {
    console.error(`${OUT} is missing. Run: pnpm docs:api`);
    process.exit(1);
  }

  if (current !== rendered) {
    console.error(
      `${OUT} is out of step with the routes. Run: pnpm docs:api\n` +
        "A route was added, removed, or had its capability changed.",
    );
    process.exit(1);
  }

  console.log(`${OUT} matches the routes (${routes.length} endpoints)`);
} else {
  writeFileSync(outPath, rendered);
  console.log(`wrote ${OUT} (${routes.length} endpoints)`);
}

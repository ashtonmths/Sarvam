import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { openapiDocument } from "../src/openapi.js";

/**
 * Writes the spec to a committed file, and fails when it drifts.
 *
 * The committed document is what a reviewer diffs when a route changes — the
 * same reason the migration journal and the env example are committed. A spec
 * that only exists at runtime is one nobody notices breaking.
 *
 *   pnpm openapi:emit          write it
 *   pnpm check:openapi         fail if the committed copy is stale
 */

const OUT = fileURLToPath(new URL("../../../docs/api/openapi.json", import.meta.url));
const rendered = `${JSON.stringify(openapiDocument(), null, 2)}\n`;

if (process.argv.includes("--check")) {
  let current = "";
  try {
    current = readFileSync(OUT, "utf8");
  } catch {
    console.error("docs/api/openapi.json is missing. Run: pnpm openapi:emit");
    process.exit(1);
  }

  if (current !== rendered) {
    console.error(
      "docs/api/openapi.json is out of step with the routes. Run: pnpm openapi:emit\n" +
        "A schema the handlers validate with changed, so the document a caller\n" +
        "builds against changed too.",
    );
    process.exit(1);
  }

  const paths = Object.keys(openapiDocument().paths).length;
  console.log(`openapi: committed spec matches the schemas (${paths} paths)`);
} else {
  writeFileSync(OUT, rendered);
  console.log(`wrote docs/api/openapi.json`);
}

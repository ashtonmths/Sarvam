import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Keeps `.env.example` authoritative. A variable added to the API's env schema
 * but not documented here is invisible to whoever deploys next, and a variable
 * documented here but absent from the schema is a lie the reader will act on.
 * Both directions fail.
 *
 * The schema is parsed as text rather than imported, because importing
 * `config.ts` would run its validation and exit on a machine with no `.env`.
 */

const root = new URL("..", import.meta.url);

function read(relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, root)), "utf8");
}

/** Keys the app never reads — consumed by compose or the toolchain. */
const DEPLOY_ONLY = new Set(["POSTGRES_PASSWORD", "N8N_ENCRYPTION_KEY"]);

/**
 * The schema body, found by balancing braces rather than by scanning for the
 * first `});`. A validator with a nested call in it — `ctx.addIssue({ … });`
 * inside a transform, say — closes a brace before the schema does, and a
 * scan-to-first-match truncates the body there and silently reports every
 * variable declared after it as undocumented.
 */
function schemaBody(source: string): string {
  const open = source.indexOf("z.object({");
  if (open === -1) throw new Error("config.ts: no z.object({ found");

  const start = source.indexOf("{", open);
  let depth = 0;
  for (let i = start; i < source.length; i++) {
    const char = source[i];
    if (char === "{") depth++;
    else if (char === "}") {
      depth--;
      if (depth === 0) return source.slice(start, i);
    }
  }
  throw new Error("config.ts: unbalanced braces in the env schema");
}

function schemaKeys(): Set<string> {
  const body = schemaBody(read("apps/api/src/config.ts"));
  const keys = new Set<string>();
  // Two-space indent means top level; anything nested is deeper and ignored.
  for (const match of body.matchAll(/^ {2}([A-Z][A-Z0-9_]*)\s*:/gm)) {
    if (match[1]) keys.add(match[1]);
  }
  return keys;
}

function webKeys(): Set<string> {
  const source = read("apps/web/lib/env.ts");
  const keys = new Set<string>();
  for (const match of source.matchAll(/process\.env\.(NEXT_PUBLIC_[A-Z0-9_]+)/g)) {
    if (match[1]) keys.add(match[1]);
  }
  return keys;
}

function exampleKeys(): Set<string> {
  const keys = new Set<string>();
  for (const line of read(".env.example").split("\n")) {
    const match = /^([A-Z][A-Z0-9_]*)=/.exec(line.trim());
    if (match?.[1]) keys.add(match[1]);
  }
  return keys;
}

const declared = new Set([...schemaKeys(), ...webKeys(), ...DEPLOY_ONLY]);
const documented = exampleKeys();

const missing = [...declared].filter((key) => !documented.has(key)).sort();
const extra = [...documented].filter((key) => !declared.has(key)).sort();

if (missing.length === 0 && extra.length === 0) {
  console.log(`.env.example is in step with the env schema (${declared.size} variables)`);
  process.exit(0);
}

if (missing.length > 0) {
  console.error("Declared in the env schema but missing from .env.example:");
  for (const key of missing) console.error(`  - ${key}`);
}
if (extra.length > 0) {
  console.error("Present in .env.example but read by nothing:");
  for (const key of extra) console.error(`  - ${key}`);
}
process.exit(1);

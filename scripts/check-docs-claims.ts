import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The one claim this product must never make.
 *
 * **Reflex does not and cannot prevent a GUI change.** Airtable's admin panel
 * has no pre-commit hook; there is no interception point, so there is nothing
 * to intercept with. Reflex detects in seconds and makes the change one click
 * from undone, and that is a genuinely weaker guarantee than prevention.
 *
 * It is also the single most tempting sentence to soften, because "we block
 * dangerous changes" sells better than "we notice them fast". A customer who
 * believes the stronger claim finds out it was false at the worst possible
 * moment, and at that point nothing else we said is trusted either.
 *
 * So it is enforced mechanically rather than by review. Any sentence in the
 * docs that puts Reflex near "prevent" or "block" has to be one that *denies*
 * the claim; anything else fails the build.
 *
 *   pnpm check:claims
 */

const root = new URL("..", import.meta.url);
const DOCS = fileURLToPath(new URL("apps/web/content/docs", root));

/** Sentences that mention both, and negate the claim. These are the good ones. */
const NEGATIONS = [
  /does not (and cannot )?block/i,
  /cannot prevent/i,
  /never described as blocking/i,
  /no page may describe/i,
  /is not a block/i,
  /no product can/i,
  /not prevention/i,
  /nothing can prevent/i,
  /weaker than prevention/i,
  /^\s*\|/, // a table row, where the honest answer lives in its own cell
];

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    return statSync(full).isDirectory()
      ? walk(full)
      : entry.endsWith(".mdx")
        ? [full]
        : [];
  });
}

const offences: string[] = [];
let scanned = 0;

for (const file of walk(DOCS)) {
  const lines = readFileSync(file, "utf8").split("\n");
  scanned++;

  for (const [index, line] of lines.entries()) {
    if (!/reflex/i.test(line)) continue;
    if (!/\b(prevent|block)/i.test(line)) continue;
    if (NEGATIONS.some((pattern) => pattern.test(line))) continue;

    offences.push(
      `${file.replace(`${DOCS}/`, "")}:${index + 1}\n      ${line.trim().slice(0, 120)}`,
    );
  }
}

if (offences.length > 0) {
  console.error(
    "docs claims check failed — Reflex described as preventing or blocking:\n",
  );
  for (const offence of offences) console.error(`  - ${offence}`);
  console.error(
    "\nReflex detects and reverts. It cannot prevent a change made in a browser\n" +
      "tab, and a customer who believes otherwise finds out at the worst moment.\n" +
      "If this line genuinely negates the claim, add its shape to NEGATIONS.",
  );
  process.exit(1);
}

console.log(`docs claims: ${scanned} pages, Reflex never described as preventing`);

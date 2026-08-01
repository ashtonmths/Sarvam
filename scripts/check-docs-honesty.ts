import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Guards the claims this product refuses to make.
 *
 * Sadhak's positioning rests on being straighter than the category: it blocks
 * what can be blocked and makes the rest reversible, and it says so. That
 * honesty is a decision recorded in ARCHITECTURE and HUMAN.md, and decisions
 * recorded only in prose erode — a marketing page gets rewritten, a README gets
 * an enthusiastic paragraph, and six months later the docs claim something a
 * sharp reviewer disproves in thirty seconds.
 *
 * Each rule below is one of those claims, with the reason it is false. A rule
 * fires on a line unless that line also carries an explicit disclaimer, so the
 * places that *discuss* the limitation stay legal.
 */

interface Rule {
  name: string;
  /** Fires when this matches a line. */
  pattern: RegExp;
  /** Suppresses the rule when the same line matches — the honest phrasings. */
  unless?: RegExp;
  why: string;
}

const RULES: Rule[] = [
  {
    name: "reflex-prevents",
    // Reflex as the subject of a prevention verb, within a few words.
    pattern: /\breflex\b[^.\n]{0,60}?\b(prevents?|prevented|blocks?|blocked|stops?)\b/i,
    // The last alternative lets a document forbid the claim ("no surface
    // anywhere claims Reflex prevents changes") without making it.
    unless:
      /\b(does not|doesn't|cannot|can't|never|not)\b|compensates|rather than|\b(no|never)\b[^.\n]{0,40}\bclaims?\b/i,
    why: "Reflex detects a change that already happened and offers a revert. Airtable and the Zapier editor expose no veto to any third party. Reflex compensates; it does not prevent.",
  },
  {
    name: "prevents-everything",
    pattern: /\bprevents? (every|all) (breakage|incident|change|outage)/i,
    unless: /\bnot\b|never claim/i,
    why: "Some tools cannot be intercepted by anyone. Claiming otherwise is the lie a reviewer catches first.",
  },
  {
    name: "incidents-prevented",
    // An unprovable counterfactual: you cannot count the outages that did not
    // happen. The measurable claims are reverts executed and time to undo.
    // Both word orders, and the vaguer quantifiers, because "prevented
    // hundreds of outages" is the same unprovable claim as "400 outages
    // prevented" and would otherwise walk straight past a one-directional rule.
    pattern:
      /\b(\d[\d,]*|hundreds|thousands|dozens)\s*(\+|plus)?\s*(incidents?|outages?|breakages?)\s+prevented\b|\bprevent(ed|s)\s+(over\s+|more than\s+)?(\d[\d,]*|hundreds|thousands|dozens)\s+(incidents?|outages?|breakages?)/i,
    why: "Incidents prevented is an unprovable counterfactual. Measure reverts executed, seconds from mistake to undone, and changes reviewed before merge.",
  },
  {
    name: "ai-decides-the-verdict",
    pattern:
      /\b(ai|llm|model|gpt)\b[^.\n]{0,40}?\b(decides?|determines?|makes)\b[^.\n]{0,20}?\bverdict/i,
    unless: /\bnot\b|never|rather than|no (ai|llm|model)/i,
    why: "The verdict is arithmetic over the graph. A model writes the explanation afterwards and can never change the decision.",
  },
  {
    name: "guessed-edges-block",
    pattern: /\b(llm_inferred|inferred|guessed)\b[^.\n]{0,40}?\bcan block\b/i,
    unless: /\bnever\b|cannot|can't|not\b/i,
    why: "Edges an agent guessed can only ever WARN. Blocking someone's Friday on a model's hunch is how the gate loses trust permanently.",
  },
  {
    name: "reads-your-data",
    pattern: /\bwe read your (data|records|rows|invoices)\b/i,
    unless: /\bnever\b|\bdo not\b|\bdon't\b/i,
    why: "Connectors read structure only. The record endpoints are absent from each connector's URL allowlist, so fetching rows throws.",
  },
];

/** Docs whose whole job is to discuss what we refuse to claim. */
const EXEMPT = new Set(["docs/CRITIQUE.md", "docs/COMPETITIVE-LANDSCAPE.md"]);

const root = new URL("..", import.meta.url);

function markdownFiles(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(fileURLToPath(new URL(dir, root)))) {
    if (entry === "node_modules" || entry === ".next" || entry.startsWith(".git")) {
      continue;
    }
    const relative = `${dir}${entry}`;
    const full = fileURLToPath(new URL(relative, root));
    if (statSync(full).isDirectory()) markdownFiles(`${relative}/`, found);
    else if (entry.endsWith(".md") || entry.endsWith(".mdx")) found.push(relative);
  }
  return found;
}

interface Finding {
  file: string;
  line: number;
  text: string;
  rule: Rule;
}

/**
 * The whole rule engine, over a string. Pure and file-free so the rules can be
 * tested directly on the phrasings they exist to judge, which is the only way
 * to also assert the honest phrasings are left alone.
 */
export function findInText(content: string): Array<{ line: number; rule: Rule }> {
  const found: Array<{ line: number; rule: Rule }> = [];

  content.split("\n").forEach((text, index) => {
    for (const rule of RULES) {
      if (!rule.pattern.test(text)) continue;
      if (rule.unless?.test(text)) continue;
      found.push({ line: index + 1, rule });
    }
  });

  return found;
}

export function scan(files: string[]): Finding[] {
  const findings: Finding[] = [];

  for (const file of files) {
    if (EXEMPT.has(file)) continue;
    const content = readFileSync(fileURLToPath(new URL(file, root)), "utf8");
    const lines = content.split("\n");

    for (const hit of findInText(content)) {
      findings.push({
        file,
        line: hit.line,
        text: (lines[hit.line - 1] ?? "").trim(),
        rule: hit.rule,
      });
    }
  }

  return findings;
}

/**
 * Only when run as the command. The rules are importable so they can be tested
 * without the import itself scanning the repository and exiting the process.
 */
function main(): void {
  const files = [...markdownFiles("docs/"), "README.md", "SECURITY.md"];
  const findings = scan(files);

  if (findings.length === 0) {
    console.log(`docs honesty: ${files.length} files clean (${RULES.length} rules)`);
    return;
  }

  console.error("Claims this product does not make:\n");
  for (const finding of findings) {
    console.error(`  ${finding.file}:${finding.line}  [${finding.rule.name}]`);
    console.error(`    ${finding.text}`);
    console.error(`    ${finding.rule.why}\n`);
  }
  process.exit(1);
}

if (process.argv[1]?.endsWith("check-docs-honesty.ts")) main();

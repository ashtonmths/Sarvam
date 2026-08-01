import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Validates the observability stack as source, so a broken dashboard or a
 * mute alert fails a pull request rather than a 2am incident.
 *
 * Three classes of bug are worth catching mechanically here, and all three are
 * silent at deploy time:
 *
 *   1. A dashboard referencing a datasource UID that provisioning does not
 *      define. Grafana renders it as an empty panel with no error, so the
 *      first person to notice is someone who needed it.
 *   2. Two dashboards sharing a UID. The second silently replaces the first.
 *   3. An alert rule without an `action` annotation. The rule still fires, and
 *      the responder gets a summary with no instruction — which is the exact
 *      moment the alert needed to be useful.
 *
 * `promtool check rules` and `amtool check-config` cover config *syntax* in
 * the same CI job; those are binaries, and this is the part they cannot judge.
 */

const root = new URL("..", import.meta.url);
const OBS = "ops/observability";

function read(path: string): string {
  return readFileSync(fileURLToPath(new URL(`${OBS}/${path}`, root)), "utf8");
}

const problems: string[] = [];

/* -------------------------------------------------------- datasource UIDs */

const datasourcesYaml = read("grafana/provisioning/datasources/datasources.yml");
const declaredUids = new Set(
  [...datasourcesYaml.matchAll(/^\s+uid:\s*(\S+)/gm)].map((match) => match[1] as string),
);

if (declaredUids.size === 0) {
  problems.push(
    "No datasource UIDs found in provisioning — the parser or the file is wrong.",
  );
}

/* ----------------------------------------------------------- dashboards */

const dashboardDir = fileURLToPath(new URL(`${OBS}/grafana/dashboards`, root));
const dashboardFiles = readdirSync(dashboardDir).filter((name) => name.endsWith(".json"));

if (dashboardFiles.length < 4) {
  problems.push(`Expected at least 4 dashboards, found ${dashboardFiles.length}.`);
}

const seenUids = new Map<string, string>();

for (const file of dashboardFiles) {
  let dashboard: { uid?: string; title?: string; panels?: unknown[] };
  try {
    dashboard = JSON.parse(readFileSync(`${dashboardDir}/${file}`, "utf8"));
  } catch (error) {
    problems.push(`${file}: not valid JSON — ${(error as Error).message}`);
    continue;
  }

  if (!dashboard.uid) {
    problems.push(`${file}: has no uid. Grafana would mint a random one per import.`);
    continue;
  }

  const previous = seenUids.get(dashboard.uid);
  if (previous) {
    problems.push(`${file}: uid "${dashboard.uid}" already used by ${previous}.`);
  }
  seenUids.set(dashboard.uid, file);

  if (!dashboard.title) problems.push(`${file}: has no title.`);
  if (!dashboard.panels?.length) problems.push(`${file}: has no panels.`);

  // Every datasource reference anywhere in the document, however nested.
  const raw = readFileSync(`${dashboardDir}/${file}`, "utf8");
  for (const match of raw.matchAll(/"uid":\s*"(sadhak-[a-z-]+)"/g)) {
    const uid = match[1] as string;
    // Dashboard uids share the prefix; only datasource references matter.
    if (uid === dashboard.uid) continue;
    if (!declaredUids.has(uid)) {
      problems.push(
        `${file}: references datasource "${uid}", which provisioning does not declare. ` +
          `Declared: ${[...declaredUids].join(", ")}`,
      );
    }
  }
}

/* --------------------------------------------------------- alert actions */

const MIN_ACTION = 40;

const alertsDir = fileURLToPath(new URL(`${OBS}/prometheus/alerts`, root));
const alertFiles = readdirSync(alertsDir).filter((name) => name.endsWith(".yml"));

let ruleCount = 0;

for (const file of alertFiles) {
  const source = readFileSync(`${alertsDir}/${file}`, "utf8");

  // Split on the alert boundary rather than parsing YAML: this file is read by
  // promtool for structure, and the only question here is per-rule content.
  const blocks = source.split(/^\s+- alert:\s*/m).slice(1);

  for (const block of blocks) {
    const name = block.split("\n")[0]?.trim() ?? "(unnamed)";
    ruleCount++;

    if (!/^\s+summary:/m.test(block)) {
      problems.push(`${file}: rule ${name} has no summary annotation.`);
    }

    const action = block.match(
      /^\s+action:\s*>-?\s*\n([\s\S]*?)(?=\n\s*(?:-\s+alert:|[a-z_]+:|$))/m,
    );
    if (!action) {
      problems.push(
        `${file}: rule ${name} has no action annotation. Every alert must name the ` +
          "first thing a human should do — a summary alone tells a responder nothing.",
      );
      continue;
    }

    const text = (action[1] ?? "").replace(/\s+/g, " ").trim();
    if (text.length < MIN_ACTION) {
      problems.push(
        `${file}: rule ${name} has an action of ${text.length} characters ` +
          `(minimum ${MIN_ACTION}). "${text}" is not an instruction.`,
      );
    }

    const runbook = block.match(/^\s+runbook_url:\s*(\S+)/m);
    if (runbook?.[1]?.startsWith("./") || runbook?.[1]?.startsWith("docs/")) {
      problems.push(
        `${file}: rule ${name} points runbook_url at ${runbook[1]}, and the runbook ` +
          "directory does not exist yet (Plan 16 is deferred). Use the action annotation.",
      );
    }
  }
}

if (ruleCount === 0) problems.push("No alert rules found.");

/* ------------------------------------------------------------------ report */

if (problems.length > 0) {
  console.error("observability check failed:\n");
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}

console.log(
  `observability: ${dashboardFiles.length} dashboards, ${declaredUids.size} datasources, ` +
    `${ruleCount} alert rules, every rule carries an action`,
);

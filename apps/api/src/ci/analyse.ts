import { ciFailures } from "@sadhak/shared/schema";
import { eq } from "drizzle-orm";
import { db, sql as raw } from "../db.js";
import { searchDocuments } from "../documents/retrieve.js";
import { searchSlack } from "../historian/tools/slack.js";
import { complete } from "../llm.js";
import { log } from "../log.js";
import { failingStepOf, signatureOf } from "./logs.js";

/**
 * What Sadhak works out about a CI failure before anyone opens the run.
 *
 * The order matters and is the whole design. Read the failure, find what this
 * merge changed, look for the same failure in this org's past, then find what
 * people said about it at the time — and only then ask a model. Every step
 * before the model is deterministic and cheap, and each one narrows what the
 * model is reasoning over. A model handed only a stack trace guesses; a model
 * handed a stack trace, the diff that preceded it, the last two times it
 * happened and the thread where someone explained it does not have to.
 *
 * If the model is unavailable the earlier steps still ran, and their output is
 * still worth posting. That is why they are stored on the row rather than held
 * in memory until the model succeeds.
 */

export interface Precedent {
  id: number;
  headSha: string;
  createdAt: Date;
  jobName: string | null;
  recommendation: string | null;
  htmlUrl: string;
}

export interface Analysis {
  cause: string;
  recommendation: string;
  confidence: number;
  /** Short quotes, each with where it came from, so a claim can be checked. */
  evidence: Array<{ source: string; detail: string }>;
  /** Set when the model declined to reach a conclusion. */
  inconclusive?: boolean;
}

/** How many past failures with the same shape are worth showing the model. */
const PRECEDENT_LIMIT = 3;
/** Paths from the merge. Enough to see the shape of it, not a full diff. */
const PATH_LIMIT = 25;

/**
 * Past failures that look like this one.
 *
 * Exact signature match first, because that is the confident answer, then a
 * full-text fallback over the stored excerpt for the near misses — a dependency
 * that changed version between the two runs shifts the signature without
 * changing what broke.
 *
 * Only rows that reached `alerted` are returned. A precedent's value is the
 * conclusion someone already acted on; an unanalysed row has nothing to say.
 */
export async function precedentFor(
  orgId: number,
  failureId: number,
  signature: string,
  excerpt: string,
): Promise<Precedent[]> {
  const terms = excerpt
    .split(/\s+/)
    .filter((w) => /^[A-Za-z][A-Za-z0-9_.-]{3,}$/.test(w))
    .slice(0, 20)
    .join(" ");

  const rows = (await raw`
    SELECT id, head_sha, created_at, job_name, html_url, analysis
    FROM ci_failures
    WHERE org_id = ${orgId}
      AND id <> ${failureId}
      AND state = 'alerted'
      AND (
        signature = ${signature}
        OR (${terms} <> '' AND failure_excerpt IS NOT NULL
            AND to_tsvector('english', failure_excerpt)
                @@ websearch_to_tsquery('english', ${terms}))
      )
    ORDER BY (signature = ${signature}) DESC, created_at DESC
    LIMIT ${PRECEDENT_LIMIT}
  `) as unknown as Array<{
    id: number;
    head_sha: string;
    created_at: Date;
    job_name: string | null;
    html_url: string;
    analysis: { recommendation?: string } | null;
  }>;

  return rows.map((row) => ({
    id: Number(row.id),
    headSha: row.head_sha,
    createdAt: row.created_at,
    jobName: row.job_name,
    recommendation: row.analysis?.recommendation ?? null,
    htmlUrl: row.html_url,
  }));
}

/** What the merge that triggered this run actually touched. */
async function pathsChanged(orgId: number, headSha: string): Promise<string[]> {
  const rows = (await raw`
    SELECT DISTINCT p.path
    FROM change_paths p
    JOIN changes c ON c.id = p.change_id
    WHERE c.org_id = ${orgId} AND c.external_id = ${headSha}
    LIMIT ${PATH_LIMIT}
  `) as unknown as Array<{ path: string }>;
  return rows.map((r) => r.path);
}

/**
 * Search terms for the human record.
 *
 * Built from the failing step and the identifiers in the error rather than the
 * raw log: Slack search on a stack trace matches nothing, because nobody pastes
 * one verbatim. What people write is the name of the thing that broke.
 */
export function slackQueryFor(stepName: string | null, excerpt: string): string {
  const identifiers = [
    ...new Set(
      (
        excerpt.match(/\b[a-z][a-z0-9_]*(?:_[a-z0-9]+)+\b|\b[A-Z][a-zA-Z]{4,}Error\b/g) ??
        []
      )
        .filter((w) => w.length > 5)
        .slice(0, 6),
    ),
  ];
  return [stepName, ...identifiers].filter(Boolean).join(" ").slice(0, 200);
}

/**
 * Failures whose log already contains the answer.
 *
 * A type error names the file, the line and the expected type. A missing module
 * names the module. Nobody needs the organisation's history to fix those, and
 * running the full pipeline on one would search Slack for a typo, spend a
 * strong-tier model call, and deliver three paragraphs where a sentence was
 * wanted. Worse, it would train people to skim the alerts — which costs
 * attention on the day the failure is genuinely subtle.
 *
 * Ordered most specific first. `matched` returns the first hit, so a compile
 * error inside a test run is reported as a compile error rather than a test
 * failure.
 */
const TRIVIAL: Array<{ re: RegExp; label: string }> = [
  { re: /error TS\d{4}:/, label: "TypeScript error" },
  { re: /\bSyntaxError\b|Unexpected token|Unexpected identifier/, label: "syntax error" },
  {
    re: /Cannot find module|Module not found|ERR_MODULE_NOT_FOUND/,
    label: "missing import",
  },
  // Both shapes, because most linters never print their own name in the
  // output CI captures. Biome reports `apps/api/src/embed.ts:2:1
  // assist/source/organizeImports` with no "biome" anywhere on the line, so
  // matching the tool name alone sent every lint failure down the expensive
  // path — the single most common trivial failure there is.
  {
    re: /\b(lint|assist)\/[a-z][a-zA-Z]*\//,
    label: "lint or formatting",
  },
  {
    re: /\b(biome|eslint|prettier|ruff|gofmt)\b[\s\S]{0,200}?\berror\b/i,
    label: "lint or formatting",
  },
  { re: /error\[E\d{4}\]/, label: "compile error" },
  { re: /\bNameError\b|\bImportError\b|\bIndentationError\b/, label: "Python error" },
];

export type Triage = { kind: "trivial"; label: string } | { kind: "investigate" };

/**
 * Whether this needs the whole pipeline or just a straight answer.
 *
 * Test failures are deliberately *not* trivial even though their logs look
 * precise. A failing assertion says what differed, never why it started
 * differing, and "why now" is exactly what the history answers.
 */
export function triage(excerpt: string): Triage {
  if (!excerpt) return { kind: "investigate" };
  const hit = TRIVIAL.find((pattern) => pattern.re.test(excerpt));
  return hit ? { kind: "trivial", label: hit.label } : { kind: "investigate" };
}

/**
 * The prompt for a break that explains itself. Short output, cheap model, no
 * retrieval — the log is the whole input because the log is the whole story.
 */
const QUICK_SYSTEM = `A CI run failed on a mistake the log already identifies — a type error, a missing import, a lint failure, or similar.

Give the fix. Do not investigate, do not speculate about causes, do not ask for more context.

Return JSON only:
{
  "cause": "one sentence: what is wrong and where, naming the file and line if the log gives them",
  "recommendation": "the exact change to make, one or two sentences",
  "confidence": 0.0 to 1.0,
  "evidence": [{"source": "log", "detail": "the line from the log that shows it"}]
}

Quote the file and line from the log. Never invent one.`;

const SYSTEM = `You explain why a CI run failed after a merge, for the engineer who has to fix it.

You are given the failing log, the files that merge changed, past failures that looked similar, and what people said in Slack. Use them. Prefer the organisation's own history over general knowledge: if this broke before and someone said why, that is the answer.

Return JSON only:
{
  "cause": "what broke and why, in one or two sentences",
  "recommendation": "the concrete next action, specific enough to start on",
  "confidence": 0.0 to 1.0,
  "inconclusive": true only if the evidence does not support a conclusion,
  "evidence": [{"source": "log|slack|history|diff", "detail": "the specific thing that supports this"}]
}

Rules:
- Recommend an action, not an investigation. "Check the logs" is not an answer; they have the logs.
- If a past failure matches, say so and say what fixed it then.
- If the evidence does not support a conclusion, set inconclusive and say what you would need. A wrong confident cause costs more than an honest "not enough here" — it sends someone down the wrong path with your authority behind it.
- Never invent a file, person, or commit that is not in the input.`;

/**
 * Runs the whole pipeline for one captured failure and stores the result.
 *
 * Throws only on programming errors. Everything external — GitHub, Slack, the
 * model — is allowed to be missing, and its absence is recorded rather than
 * raised, because a partial analysis posted now beats a complete one posted
 * after someone has already debugged it by hand.
 */
export async function analyseFailure(failureId: number): Promise<void> {
  const [row] = await db.select().from(ciFailures).where(eq(ciFailures.id, failureId));
  if (!row) return;

  const [repo] = (await raw`
    SELECT owner, name, installation_id FROM repositories WHERE id = ${row.repositoryId}
  `) as unknown as Array<{ owner: string; name: string; installation_id: number | null }>;
  if (!repo) return;

  const step = await failingStepOf(
    repo.owner,
    repo.name,
    row.runId,
    repo.installation_id === null ? null : Number(repo.installation_id),
  );

  const excerpt = step?.excerpt ?? "";
  const signature = excerpt ? signatureOf(excerpt) : "";

  await db
    .update(ciFailures)
    .set({
      jobName: step?.jobName ?? null,
      stepName: step?.stepName ?? null,
      failureExcerpt: excerpt || null,
      signature: signature || null,
    })
    .where(eq(ciFailures.id, failureId));

  /**
   * The short path, taken before any retrieval happens.
   *
   * Everything below this block — precedent, Slack, documents — is skipped for
   * a failure that already says what is wrong. That is most of the cost of this
   * feature and all of its latency, spent only where it buys something.
   */
  const verdict = triage(excerpt);
  if (verdict.kind === "trivial") {
    const quick = await complete({
      tier: "bulk",
      orgId: row.orgId,
      caller: "ci.analyse.quick",
      responseFormat: { type: "json_object" },
      messages: [
        { role: "system", content: QUICK_SYSTEM },
        {
          role: "user",
          content: `Failing job: ${step?.jobName ?? "unknown"}${
            step?.stepName ? ` / ${step.stepName}` : ""
          }\n\n${excerpt}`,
        },
      ],
    });

    const parsed = parseAnalysis(quick.content);
    if (parsed) {
      await db
        .update(ciFailures)
        .set({
          analysis: {
            ...parsed,
            quickFix: true,
            quickLabel: verdict.label,
            precedent: [],
          },
          state: "analysed",
          analysedAt: new Date(),
        })
        .where(eq(ciFailures.id, failureId));

      log().info(
        { event: "ci_failure_analysed", failureId, quick: true, label: verdict.label },
        "ci: quick fix identified",
      );
      return;
    }
    // Falling through on an unparseable quick answer rather than failing: the
    // full path is slower and dearer, but it is more likely to produce
    // something, and by here we already know the run is broken.
  }

  const [precedent, paths] = await Promise.all([
    excerpt ? precedentFor(row.orgId, failureId, signature, excerpt) : [],
    pathsChanged(row.orgId, row.headSha),
  ]);

  const query = slackQueryFor(step?.stepName ?? null, excerpt);
  const slack = query
    ? await searchSlack(
        { orgId: row.orgId, edgeId: 0, seenUrls: new Set(), seenContent: new Map() },
        query,
      )
    : { hits: [], unavailable: "No search terms could be derived from the failure." };

  // Uploaded notes are searched with the same terms. A runbook or a postmortem
  // explaining this failure is exactly the sort of thing that gets written once
  // and never found again.
  const docs = query ? await searchDocuments(row.orgId, query, 4) : [];

  const context = [
    `Repository: ${repo.owner}/${repo.name}`,
    `Branch: ${row.branch}    Commit: ${row.headSha.slice(0, 10)}`,
    row.prNumber ? `Merged PR: #${row.prNumber}` : null,
    `Workflow: ${row.workflowName}`,
    step
      ? `Failing job: ${step.jobName}${step.stepName ? ` / ${step.stepName}` : ""}`
      : null,
    "",
    excerpt
      ? `--- failing log (tail) ---\n${excerpt}`
      : "--- failing log unavailable ---",
    "",
    paths.length > 0
      ? `--- files this merge changed ---\n${paths.join("\n")}`
      : "--- no recorded file changes for this commit ---",
    "",
    precedent.length > 0
      ? `--- this org has failed this way before ---\n${precedent
          .map(
            (p) =>
              `${p.createdAt.toISOString().slice(0, 10)} on ${p.headSha.slice(0, 8)}` +
              `${p.jobName ? ` (${p.jobName})` : ""}` +
              `${p.recommendation ? `\n  resolved by: ${p.recommendation}` : ""}`,
          )
          .join("\n")}`
      : "--- no similar past failure on record ---",
    "",
    slack.hits.length > 0
      ? `--- what people said in Slack ---\n${slack.hits
          .slice(0, 6)
          .map((h) => `[${h.permalink}] ${h.text.slice(0, 400)}`)
          .join("\n")}`
      : `--- no Slack context (${slack.unavailable ?? "nothing matched"}) ---`,
    "",
    docs.length > 0
      ? `--- from uploaded documents ---\n${docs
          .map((d) => `[${d.permalink}] ${d.title}: ${d.body.slice(0, 400)}`)
          .join("\n")}`
      : "",
  ]
    .filter((part) => part !== null)
    .join("\n");

  const completion = await complete({
    tier: "strong",
    orgId: row.orgId,
    caller: "ci.analyse",
    responseFormat: { type: "json_object" },
    messages: [
      { role: "system", content: SYSTEM },
      { role: "user", content: context },
    ],
  });

  const analysis = parseAnalysis(completion.content);
  if (!analysis) {
    throw new Error("the model did not return a usable analysis");
  }

  await db
    .update(ciFailures)
    .set({
      analysis: { ...analysis, precedent, paths },
      state: "analysed",
      analysedAt: new Date(),
    })
    .where(eq(ciFailures.id, failureId));

  log().info(
    { event: "ci_failure_analysed", failureId, confidence: analysis.confidence },
    "ci: failure analysed",
  );
}

/**
 * Parses the model's JSON, and refuses anything without a cause.
 *
 * Models asked for JSON sometimes wrap it in a fenced block despite being told
 * not to, so the fence is stripped before parsing rather than treated as a
 * failure. Beyond that it is strict: an object missing `cause` is not a thin
 * analysis, it is not an analysis, and storing it would put an empty finding in
 * front of an engineer with Sadhak's name on it.
 */
export function parseAnalysis(content: string | null): Analysis | null {
  if (!content) return null;
  const cleaned = content
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;

  const value = parsed as Record<string, unknown>;
  const cause = typeof value.cause === "string" ? value.cause.trim() : "";
  if (!cause) return null;

  const rawConfidence = typeof value.confidence === "number" ? value.confidence : 0.5;

  return {
    cause,
    recommendation:
      typeof value.recommendation === "string" && value.recommendation.trim()
        ? value.recommendation.trim()
        : "No specific action proposed.",
    // Clamped: models return 95 for "95%" often enough that an unclamped value
    // would render as a 9500% confident finding.
    confidence: Math.max(
      0,
      Math.min(1, rawConfidence > 1 ? rawConfidence / 100 : rawConfidence),
    ),
    evidence: Array.isArray(value.evidence)
      ? value.evidence
          .filter(
            (e): e is Record<string, unknown> => typeof e === "object" && e !== null,
          )
          .map((e) => ({
            source: String(e.source ?? "unknown"),
            detail: String(e.detail ?? ""),
          }))
          .filter((e) => e.detail)
      : [],
    ...(value.inconclusive === true ? { inconclusive: true } : {}),
  };
}

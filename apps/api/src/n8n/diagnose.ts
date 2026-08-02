import { n8nExecutionFailures } from "@sadhak/shared/schema";
import { eq } from "drizzle-orm";
import { candidatesBefore, windowsFrom } from "../changes/checkpoints.js";
import { db, sql as raw } from "../db.js";
import { searchDocuments } from "../documents/retrieve.js";
import { searchSlack } from "../historian/tools/slack.js";
import { complete } from "../llm.js";
import { log } from "../log.js";
import { traverse } from "../sentinel/traverse.js";
import { openPrsTouching } from "./open-prs.js";

/**
 * Why an n8n workflow failed, and who it hurt.
 *
 * The order is the design, and it runs cheapest-first on purpose:
 *
 *  1. Impact — who depends on this workflow. Graph traversal, no model.
 *  2. Widen — walk back through up to three checkpoint windows, stopping at
 *     the first that contains a landed change.
 *  3. Is this ours? If no window held one, stop. A workflow fails because a
 *     vendor is down or a credential expired far more often than because we
 *     shipped something, and spending a reasoning model to conclude "not ours"
 *     on each of those is how the budget disappears.
 *  4. Is it already fixed? If an open PR touches the files that changed, say
 *     so and stop. "Merge #482" beats a root-cause essay when the work is done.
 *  5. Gather — the written record, searched on the error and the workflow.
 *  6. Reason — one model call over everything gathered.
 *
 * Every step before 6 is deterministic. Each one either answers the question
 * outright or narrows what the model has to consider, which is what makes a
 * cheap model sufficient at the end.
 */

export interface ImpactedNode {
  nodeId: number;
  name: string;
  kind: string;
  hops: number;
  score: number;
}

export interface Narrative {
  headline: string;
  action: string;
  why: string;
  questions: string[];
}

export interface Diagnosis {
  impact: { count: number; top: ImpactedNode[] };
  cause: string;
  recommendation: string;
  confidence: number;
  evidence: Array<{ source: string; detail: string }>;
  /** How many windows were tried. */
  windowsSearched: number;
  /** What the last one actually was, in words — a checkpoint, or a blind lookback. */
  searchReach: string;
  schemaChangeSuspected: boolean;
}

/** How many earlier checkpoints the search may fall back through. */
const MAX_WINDOWS = 3;
/** Impacted nodes worth naming in a Slack message. */
const TOP_IMPACT = 5;
/**
 * Changes read from the window, and changes shown to the model.
 *
 * Two numbers, because one was wrong. The cap used to be a SQL LIMIT, so a
 * busy window silently truncated the *evidence*: schema detection and the
 * open-PR path search both ran over the twenty most recent changes, and a
 * migration sitting twenty-fifth was invisible to the feature's own headline
 * case. The scan now reads the whole window and only the prompt is trimmed.
 */
export const MAX_CHANGES_SCANNED = 200;
export const MAX_CHANGES_SHOWN = 20;

/**
 * Everything downstream of the failed workflow.
 *
 * This is the "how much did it impact" answer, and it comes from the graph
 * rather than from the model — it is a traversal over recorded dependencies, so
 * it is the same number every time and can be checked by opening the map.
 */
export async function impactOf(
  orgId: number,
  nodeId: number,
): Promise<{ count: number; top: ImpactedNode[] }> {
  const rows = await traverse(orgId, nodeId);
  if (rows.length === 0) return { count: 0, top: [] };

  // traverse already returns name and kind, so there is no second lookup here.
  // Ranked by `impact`, which is the traversal's own decayed score — the same
  // ordering the blast radius uses everywhere else, so the workflow's top
  // dependants read the same here as they do on the map.
  const top = rows
    .map((row) => ({
      nodeId: row.id,
      name: row.name,
      kind: row.kind,
      hops: row.hops,
      score: row.impact,
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, TOP_IMPACT);

  return { count: rows.length, top };
}

interface ChangeRow {
  external_id: string;
  title: string | null;
  author: string | null;
  occurred_at: Date;
  paths: string[];
}

/**
 * The row as the driver actually hands it back.
 *
 * `occurred_at` arrives as a string here, and the `as unknown as` cast around a
 * raw query is an assertion the compiler simply believes — so declaring it as
 * Date typechecked, passed every test, and threw on the first `.toISOString()`
 * at runtime. Naming the wire shape separately is what stops the lie.
 */
interface RawChangeRow extends Omit<ChangeRow, "occurred_at"> {
  occurred_at: Date | string;
}

/**
 * Changes that actually *landed* inside a window, with the files they touched.
 *
 * Commits only, and that restriction is the fix for a circular answer rather
 * than a performance choice. github-client stores a pull request at
 * `merged_at ?? created_at`, so an **open** PR is a row in `changes` dated when
 * it was opened. Without this filter a vendor outage at 14:00 with an unrelated
 * PR opened at 13:00 would pass the "did anything change" gate *because of that
 * PR*, then have the open-PR lookup find the same PR and recommend merging it
 * as the fix. The PR was the change, the fix, and the reason the unrelated exit
 * did not fire.
 *
 * A commit is unambiguous: it is in the branch. A merged PR contributes its
 * commits anyway, so nothing real is lost.
 */
async function changesIn(orgId: number, from: Date, to: Date): Promise<ChangeRow[]> {
  const rows = (await raw`
    SELECT c.external_id, c.title, c.author_login AS author, c.occurred_at,
           COALESCE(array_agg(DISTINCT p.path) FILTER (WHERE p.path IS NOT NULL), '{}') AS paths
    FROM changes c
    LEFT JOIN change_paths p ON p.change_id = c.id
    -- Cast, because the driver leaves an uncast Date parameter for Postgres to
    -- infer and it lands on text, which fails the bind before the query runs.
    WHERE c.org_id = ${orgId}
      AND c.kind = 'commit'
      AND c.occurred_at > ${from.toISOString()}::timestamptz
      AND c.occurred_at <= ${to.toISOString()}::timestamptz
    GROUP BY c.id, c.external_id, c.title, c.author_login, c.occurred_at
    ORDER BY c.occurred_at DESC
    LIMIT ${MAX_CHANGES_SCANNED}
  `) as unknown as RawChangeRow[];

  return rows.map((row) => ({
    ...row,
    occurred_at:
      row.occurred_at instanceof Date ? row.occurred_at : new Date(row.occurred_at),
  }));
}

/**
 * Whether anything in this set of changes looks like a schema change.
 *
 * Deliberately a path and title heuristic rather than parsing SQL. The point is
 * to tell the model that a migration landed in the window so it weighs it, not
 * to decide the answer — a false positive costs one sentence of context, and a
 * false negative would hide the single most common cause of a workflow that
 * queried a column yesterday and cannot today.
 */
export function looksLikeSchemaChange(changes: ChangeRow[]): boolean {
  return changes.some(
    (change) =>
      change.paths.some((path) =>
        /migrations?\/|\.sql$|schema\.(ts|js|py|rb)$|alembic|liquibase|flyway/i.test(
          path,
        ),
      ) ||
      /\b(migration|schema|alter table|drop column|rename column)\b/i.test(
        change.title ?? "",
      ),
  );
}

/**
 * The second pass: writing the message, not the diagnosis.
 *
 * The first call works out what broke. This one decides what an engineer woken
 * at 3am needs to read first, which is a different job — a correct diagnosis
 * rendered through a template still opens with a field label, and the reader
 * has to assemble the point themselves.
 *
 * It is given the conclusion plus what the conclusion rests on, and it may not
 * add to either. Its whole freedom is ordering and phrasing.
 */
const NARRATE = `You write the Slack message for a workflow failure that has already been diagnosed.

You are given the diagnosis, what depends on the workflow, and the evidence behind it. Do not add facts. Do not soften the conclusion or hedge one that was stated confidently.

Return JSON only:
{
  "headline": "one line: what broke and who it affects. No emoji, no 'Alert:'.",
  "action": "the single next step, imperative, specific enough to start on",
  "why": "two sentences at most, the reasoning a reader needs to accept the action",
  "questions": ["2-3 short questions worth deciding in the thread"]
}

Rules:
- The headline names the workflow and the consequence, not the error class.
- The action is something a person does, not something they investigate.
- If the diagnosis was inconclusive, say so in the headline rather than implying certainty.
- No preamble, no restating the JSON keys in prose.`;

const SYSTEM = `You diagnose why an automation workflow failed, for the person who owns it.

You are given: what the workflow is and what it depends on, what it broke for, the error, the changes that landed on our side in the window, and any notes or transcripts that mention it.

Return JSON only:
{
  "cause": "what broke and why, one or two sentences",
  "recommendation": "the concrete next action, specific enough to start on",
  "confidence": 0.0 to 1.0,
  "evidence": [{"source": "error|change|document|impact", "detail": "the specific thing that supports this"}]
}

Rules:
- Prefer a change in the window over a general explanation. If a migration touched a table this workflow reads, say so and name it.
- Recommend an action, not an investigation.
- If the changes in the window do not plausibly explain the error, say that plainly and set confidence low. A wrong confident cause sends someone down the wrong path with our authority behind it.
- Never invent a file, commit, person or table that is not in the input.`;

/**
 * Runs the pipeline for one captured failure and stores the result.
 *
 * Stores a terminal state in every branch, including the early exits, so a
 * failure never sits in `captured` with nothing scheduled to explain it.
 */
export async function diagnoseFailure(failureId: number): Promise<void> {
  const [row] = await db
    .select()
    .from(n8nExecutionFailures)
    .where(eq(n8nExecutionFailures.id, failureId));
  if (!row) return;

  /**
   * Already diagnosed, so stop before spending anything.
   *
   * The handler posts to Slack after this returns, and a throw from that post
   * retries the whole job — which re-entered here and bought a second graph
   * traversal, a second GitHub scan and a second strong-tier completion for a
   * failure that was already explained. Three attempts, three diagnoses, one
   * failure.
   */
  if (row.diagnosisState !== "captured") return;

  const failedAt = row.stoppedAt ?? row.startedAt ?? row.detectedAt;

  // 1. Impact — always computed, even if the diagnosis stops early. "Nothing
  //    downstream" is as useful to know as a long list.
  const impact = row.nodeId
    ? await impactOf(row.orgId, row.nodeId)
    : { count: 0, top: [] };

  /**
   * 2. Widen through checkpoints until the window holds changes.
   *
   * The ladder is the same one incident investigation uses: start at the last
   * moment things were known good and only reach further back when that window
   * explains nothing. Bounded at three, because a fourth window is wide enough
   * that "a change happened in it" stops being evidence of anything.
   */
  // Scoped to this workflow's node, not `{}`.
  //
  // candidatesBefore excludes checkpoints belonging to a *different* node only
  // when it is told which node this is, and it ranks scoped checkpoints ahead
  // of org-wide ones. Passing an empty scope inverted that: three unrelated
  // Reflex recoveries from twenty minutes ago outranked the release checkpoint
  // from three hours ago, so every window was minutes wide, every one was
  // empty, and the deploy that actually broke this was never inside any of
  // them. The ladder widened correctly across entirely the wrong candidates.
  const candidates = await candidatesBefore(
    row.orgId,
    failedAt,
    row.nodeId ? { nodeId: row.nodeId } : {},
    12,
  );
  const windows = windowsFrom(candidates, failedAt, MAX_WINDOWS);

  let changes: ChangeRow[] = [];
  let windowsSearched = 0;
  let searchReach = "no window was searched";
  for (const window of windows) {
    windowsSearched += 1;
    // Recorded, because `windowsSearched` alone cannot distinguish a two-minute
    // crawl window from the synthetic 24-hour lookback used when an org has no
    // checkpoints at all — and reporting the second as "1 checkpoint window
    // searched" claims a known-good starting point that never existed.
    searchReach = window.reason;
    changes = await changesIn(row.orgId, window.from, window.to);
    if (changes.length > 0) break;
  }

  /**
   * 3. Nothing changed on our side, so this is not ours to explain.
   *
   * Recorded as an answer rather than a failure. A workflow fails when a vendor
   * is down or a credential expires, and those outnumber the ones we caused —
   * spending a model call to conclude "nothing we did" on each of them is how
   * the budget disappears.
   */
  if (changes.length === 0) {
    await db
      .update(n8nExecutionFailures)
      .set({
        diagnosisState: "unrelated",
        diagnosedAt: new Date(),
        diagnosis: {
          impact,
          cause:
            "No change on our side landed in the searched window, so this failure is unlikely to be caused by our code or schema.",
          recommendation:
            "Check the workflow's credentials and the service it calls. Nothing we shipped in this window touches it.",
          confidence: 0.5,
          evidence: [],
          windowsSearched,
          searchReach,
          schemaChangeSuspected: false,
        } satisfies Diagnosis,
      })
      .where(eq(n8nExecutionFailures.id, failureId));

    log().info(
      { event: "n8n_failure_unrelated", failureId, windowsSearched },
      "n8n: no change in window, stopping before the model",
    );
    return;
  }

  const schemaChangeSuspected = looksLikeSchemaChange(changes);
  const paths = [...new Set(changes.flatMap((change) => change.paths))].slice(0, 40);

  /**
   * 4. Already fixed but not merged.
   *
   * Checked before the model because it is both the cheapest answer and the
   * best one: the fix exists, and what is missing is a merge rather than an
   * investigation.
   */
  /**
   * Every tracked repository, not the first one found.
   *
   * This was `LIMIT 1` with no ORDER BY, so an org tracking more than one
   * repository had the open-PR check silently consult an arbitrary one — and
   * the fix, if it existed, was usually in the repository that actually
   * changed.
   */
  const repos = (await raw`
    SELECT owner, name, installation_id FROM repositories WHERE org_id = ${row.orgId}
    ORDER BY id
  `) as unknown as Array<{ owner: string; name: string; installation_id: number | null }>;

  if (repos.length > 0 && paths.length > 0) {
    const open = (
      await Promise.all(
        repos.map((repo) =>
          openPrsTouching(
            repo.owner,
            repo.name,
            repo.installation_id === null ? null : Number(repo.installation_id),
            paths,
          ),
        ),
      )
    ).flat();

    if (open.length > 0) {
      const best = open[0] as (typeof open)[number];
      await db
        .update(n8nExecutionFailures)
        .set({
          diagnosisState: "fix_pending",
          diagnosedAt: new Date(),
          diagnosis: {
            impact,
            cause: `An open pull request already touches ${best.matchedPaths.join(", ")}, which changed in the window this workflow started failing.`,
            recommendation: `Review and merge #${best.number} — "${best.title}"${best.author ? ` by ${best.author}` : ""}. It may already contain the fix.`,
            confidence: 0.65,
            evidence: open.map((pr) => ({
              source: "change",
              detail: `#${pr.number} ${pr.title} touches ${pr.matchedPaths.join(", ")} — ${pr.url}`,
            })),
            windowsSearched,
            searchReach,
            schemaChangeSuspected,
          } satisfies Diagnosis,
        })
        .where(eq(n8nExecutionFailures.id, failureId));

      log().info(
        { event: "n8n_failure_fix_pending", failureId, pr: best.number },
        "n8n: an open PR may already fix this",
      );
      return;
    }
  }

  // 5. Gather the written record. Search on the error and the workflow name —
  //    what people write about is the thing that broke, not the stack.
  const query = [row.workflowName, row.failedNode, row.errorMessage]
    .filter(Boolean)
    .join(" ")
    .slice(0, 200);
  /**
   * Both written records, not just the uploaded one.
   *
   * This searched documents and stopped, which meant the diagnosis never saw
   * the place engineers actually explain things to each other. A workflow that
   * broke at 03:12 is usually discussed in a channel before anyone writes it
   * down anywhere else, and skipping that made the model reason from the error
   * and the diff alone — the two things the reader already has.
   */
  const [docs, slack] = await Promise.all([
    query ? searchDocuments(row.orgId, query, 4) : Promise.resolve([]),
    query
      ? searchSlack({ orgId: row.orgId }, query)
      : Promise.resolve({ hits: [], unavailable: "no search terms" }),
  ]);

  const context = [
    `Workflow: ${row.workflowName ?? row.workflowId}`,
    row.failedNode ? `Failed at node: ${row.failedNode}` : null,
    `Error: ${row.errorMessage ?? "(none recorded)"}`,
    `Mode: ${row.mode ?? "unknown"}    Failed at: ${failedAt.toISOString()}`,
    "",
    impact.count > 0
      ? `--- what depends on this workflow (${impact.count} nodes) ---\n${impact.top
          .map((n) => `${n.name} (${n.kind}, ${n.hops} hop${n.hops === 1 ? "" : "s"})`)
          .join("\n")}`
      : "--- nothing recorded downstream of this workflow ---",
    "",
    `--- changes on our side (${windowsSearched} window${windowsSearched === 1 ? "" : "s"} searched; ${searchReach}) ---`,
    changes
      .slice(0, MAX_CHANGES_SHOWN)
      .map(
        (change) =>
          `${change.occurred_at.toISOString().slice(0, 16)} ${change.external_id.slice(0, 8)}` +
          `${change.author ? ` by ${change.author}` : ""}: ${change.title ?? "(no title)"}` +
          `${change.paths.length > 0 ? `\n    touched: ${change.paths.slice(0, 8).join(", ")}` : ""}`,
      )
      .join("\n"),
    "",
    schemaChangeSuspected
      ? "--- note: at least one change in this window looks like a database migration ---"
      : "",
    slack.hits.length > 0
      ? `--- what people said in Slack ---\n${slack.hits
          .slice(0, 6)
          .map((h) => `[${h.permalink}] ${h.text.slice(0, 400)}`)
          .join("\n")}`
      : `--- no Slack context (${slack.unavailable ?? "nothing matched"}) ---`,
    "",
    docs.length > 0
      ? `--- from written notes ---\n${docs.map((d) => `[${d.permalink}] ${d.title}: ${d.body.slice(0, 400)}`).join("\n")}`
      : "",
  ]
    .filter((part) => part !== null && part !== "")
    .join("\n");

  // 6. One model call, over a window that the deterministic steps narrowed.
  const completion = await complete({
    tier: "strong",
    orgId: row.orgId,
    caller: "n8n.diagnose",
    responseFormat: { type: "json_object" },
    messages: [
      { role: "system", content: SYSTEM },
      { role: "user", content: context },
    ],
  });

  const parsed = parseDiagnosis(completion.content);
  if (!parsed) throw new Error("the model did not return a usable diagnosis");

  /**
   * Compose the message from the finished diagnosis.
   *
   * Cheap tier, because this is a writing task over a conclusion that has
   * already been reached — the expensive reasoning happened above. A failure
   * here is not fatal: the alert falls back to rendering the fields directly,
   * which is what it did before this existed.
   */
  const narrative = await narrate({
    workflow: row.workflowName ?? row.workflowId,
    failedNode: row.failedNode,
    error: row.errorMessage,
    parsed,
    impact,
    orgId: row.orgId,
  });

  await db
    .update(n8nExecutionFailures)
    .set({
      diagnosisState: "diagnosed",
      diagnosedAt: new Date(),
      diagnosis: {
        ...parsed,
        impact,
        windowsSearched,
        searchReach,
        schemaChangeSuspected,
        ...(narrative ? { narrative } : {}),
      } satisfies Diagnosis,
    })
    .where(eq(n8nExecutionFailures.id, failureId));

  log().info(
    {
      event: "n8n_failure_diagnosed",
      failureId,
      confidence: parsed.confidence,
      windowsSearched,
    },
    "n8n: failure diagnosed",
  );
}

/** Parses the model's JSON, refusing anything without a cause. */
export function parseDiagnosis(
  content: string | null,
): Omit<
  Diagnosis,
  "impact" | "windowsSearched" | "searchReach" | "schemaChangeSuspected"
> | null {
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
    // Models return 95 for "95%" often enough that this must not render as 9500%.
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
  };
}

/**
 * Turns a diagnosis into the message. Returns null rather than throwing: an
 * alert that reads like a template is worth far more than no alert at all.
 */
async function narrate(input: {
  workflow: string;
  failedNode: string | null;
  error: string | null;
  parsed: {
    cause: string;
    recommendation: string;
    confidence: number;
    evidence: Array<{ source: string; detail: string }>;
    inconclusive?: boolean;
  };
  impact: { count: number; top: ImpactedNode[] };
  orgId: number;
}): Promise<Narrative | null> {
  try {
    const completion = await complete({
      tier: "bulk",
      orgId: input.orgId,
      caller: "n8n.narrate",
      responseFormat: { type: "json_object" },
      messages: [
        { role: "system", content: NARRATE },
        {
          role: "user",
          content: [
            `Workflow: ${input.workflow}`,
            input.failedNode ? `Failed at: ${input.failedNode}` : null,
            input.error ? `Error: ${input.error}` : null,
            `Cause: ${input.parsed.cause}`,
            `Recommendation: ${input.parsed.recommendation}`,
            `Confidence: ${input.parsed.confidence}${input.parsed.inconclusive ? " (inconclusive)" : ""}`,
            input.impact.count > 0
              ? `Depends on it (${input.impact.count}): ${input.impact.top.map((n) => n.name).join(", ")}`
              : "Nothing recorded downstream.",
            input.parsed.evidence.length > 0
              ? `Evidence:\n${input.parsed.evidence.map((e) => `- ${e.source}: ${e.detail}`).join("\n")}`
              : null,
          ]
            .filter(Boolean)
            .join("\n"),
        },
      ],
    });

    const cleaned = (completion.content ?? "")
      .trim()
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/, "");
    const value = JSON.parse(cleaned) as Record<string, unknown>;

    const headline = typeof value.headline === "string" ? value.headline.trim() : "";
    const action = typeof value.action === "string" ? value.action.trim() : "";
    if (!headline || !action) return null;

    return {
      headline,
      action,
      why: typeof value.why === "string" ? value.why.trim() : input.parsed.cause,
      questions: Array.isArray(value.questions)
        ? value.questions.filter((q): q is string => typeof q === "string").slice(0, 3)
        : [],
    };
  } catch {
    return null;
  }
}

import { rationale } from "@sadhak/shared/schema";
import { eq } from "drizzle-orm";
import { config } from "../../config.js";
import { closePools, db, sql } from "../../db.js";
import { putCredential } from "../../vault/vault.js";
import { runLoop } from "../loop.js";
import { type CaseClass, HISTORIAN_CASES, type HistorianCase } from "./corpus.js";
import {
  FIXTURE_PORT,
  type FixtureServer,
  startFixtureServer,
} from "./fixture-server.js";

/**
 * Scores the Historian against planted truth.
 *
 *   pnpm eval:historian                 every case
 *   pnpm eval:historian -- --case=vat   one case, by name substring
 *   pnpm eval:historian -- --trials=3   majority over N trials
 *
 * Deliberately not in CI, and the arithmetic is why. A loop is multi-step, call
 * it six model requests, so this corpus at three trials is roughly 130 requests
 * — against a free-tier cap of 50/day, or 1,000/day after the one-time credit,
 * under a 20 rpm ceiling that is account-wide across every process sharing the
 * key. A per-PR eval would spend the day's quota and starve every developer's
 * Historian and every demo for as long as it ran. Run it when the prompt
 * changes, when the model changes, and before trusting a proposal further than
 * the review queue.
 *
 * **The exit code keys off fabrication alone.** A run can score mediocre on
 * recall and pass; it cannot invent a citation and pass. A Historian that
 * confabulates one rationale is worse than one that finds nothing, because a
 * wrong explanation attached to a dependency is one somebody will read and
 * believe.
 */

interface Result {
  name: string;
  class: CaseClass;
  outcome: "proposed" | "gave_up" | "error";
  citedUrl: string | null;
  verdict: "correct" | "missed" | "fabricated";
  detail: string;
  /** Tools the agent actually called, in order. */
  tools?: string[];
  /** Slack endpoints the fixture served, so "did it look" is answerable. */
  fixtureCalls?: string[];
}

function arg(name: string): string | undefined {
  return process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
}

/** One trial: a fresh org, this case's workspace, the real loop. */
async function runCase(testCase: HistorianCase, fixture: FixtureServer): Promise<Result> {
  fixture.setPlanted(testCase.planted);
  const base = { name: testCase.name, class: testCase.class };
  // Tracked outside the try so the cleanup below can reach it. The first
  // version deleted the org on the happy path only, and every failing case
  // left one behind — which the launch funnel query then reported as a stalled
  // customer. An eval that pollutes the table it is measured against is worse
  // than no eval.
  let orgId: number | undefined;

  try {
    const [org] = await sql<{ id: string }[]>`
      INSERT INTO organizations (name, slug)
      VALUES ('Historian eval', ${`heval-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`})
      RETURNING id
    `;
    orgId = Number(org?.id);

    const [instance] = await sql<{ id: string }[]>`
      INSERT INTO connector_instances (org_id, connector, display_name, config)
      VALUES (${orgId}, 'slack', 'eval', '{}'::jsonb) RETURNING id
    `;
    const instanceId = Number(instance?.id);

    // A bot token, so the tool takes the conversations.history path the fixture
    // serves. Written through the vault rather than as raw SQL: the table has
    // columns the vault fills in (a fingerprint, among others), and a
    // hand-built row is both a maintenance trap and a way to exercise a code
    // path production never takes. The value is never a real credential.
    await putCredential({
      orgId,
      instanceId,
      scope: "read",
      kind: "oauth_access",
      value: "xoxb-eval-not-a-real-token",
    });

    for (const channel of new Set(testCase.planted.map((m) => m.channel))) {
      await sql`
        INSERT INTO mining_scopes (org_id, connector, scope_value, added_by)
        VALUES (${orgId}, 'slack', ${channel}, 'eval')
      `;
    }

    const [src] = await sql<{ id: string }[]>`
      INSERT INTO nodes (org_id, kind, name, external_id, connector)
      VALUES (${orgId}, 'table', ${testCase.edge.srcName}, ${`${orgId}/src`}, 'postgres')
      RETURNING id
    `;
    const [dst] = await sql<{ id: string }[]>`
      INSERT INTO nodes (org_id, kind, name, external_id, connector)
      VALUES (${orgId}, 'report', ${testCase.edge.dstName}, ${`${orgId}/dst`}, 'postgres')
      RETURNING id
    `;
    const [edge] = await sql<{ id: string }[]>`
      INSERT INTO edges (org_id, src_id, dst_id, kind, provenance, confidence)
      VALUES (${orgId}, ${Number(src?.id)}, ${Number(dst?.id)},
              ${testCase.edge.edgeKind}, 'static_parse', 1)
      RETURNING id
    `;
    const edgeId = Number(edge?.id);

    const outcome = await runLoop(
      {
        edgeId,
        srcName: testCase.edge.srcName,
        dstName: testCase.edge.dstName,
        edgeKind: testCase.edge.edgeKind,
      },
      {
        orgId,
        edgeId,
        seenUrls: new Set<string>(),
        seenContent: new Map<string, string>(),
        runId: `eval-${testCase.name}`,
        stepBudget: 8,
        maxParseFailures: 3,
        budget: { hasHeadroom: async () => true, record: async () => undefined },
        cancelled: async () => false,
      },
    );

    let citedUrl: string | null = null;
    if (outcome.kind === "proposed") {
      const [row] = await db
        .select({ url: rationale.sourceUrl })
        .from(rationale)
        .where(eq(rationale.id, outcome.rationaleId))
        .limit(1);
      citedUrl = row?.url ?? null;
    }

    // Captured before the org is dropped: when a case misses, the first
    // question is always whether the agent looked at all, and the tool trace is
    // the difference between "the model judged badly" and "the harness served
    // it nothing".
    const steps = await sql<{ tool: string }[]>`
      SELECT tool FROM agent_traces WHERE org_id = ${orgId} ORDER BY id
    `;

    return {
      ...base,
      ...score(testCase, outcome.kind, citedUrl),
      tools: steps.map((s) => s.tool),
      fixtureCalls: [...fixture.calls],
    };
  } catch (error) {
    return {
      ...base,
      outcome: "error",
      citedUrl: null,
      verdict: "missed",
      detail: error instanceof Error ? error.message : String(error),
    };
  } finally {
    if (orgId !== undefined) {
      await sql`DELETE FROM organizations WHERE id = ${orgId}`;
    }
  }
}

/**
 * The asymmetry lives here.
 *
 * `fabricated` is reserved for a citation that is wrong — a decoy, or a URL
 * that was never planted at all. Failing to find real evidence is `missed`,
 * which is disappointing rather than dangerous.
 */
function score(
  testCase: HistorianCase,
  kind: string,
  citedUrl: string | null,
): Pick<Result, "outcome" | "citedUrl" | "verdict" | "detail"> {
  const outcome =
    kind === "proposed" ? "proposed" : kind === "gave_up" ? "gave_up" : "error";

  if (outcome === "error") {
    return { outcome, citedUrl, verdict: "missed", detail: `loop ended: ${kind}` };
  }

  const planted = new Set(
    testCase.planted.map(
      (m) =>
        `https://sadhak-eval.slack.com/archives/${m.channel}/p${m.ts.replace(".", "")}`,
    ),
  );

  if (outcome === "gave_up") {
    const shouldHave = testCase.class === "unanswerable" || testCase.class === "decoy";
    return {
      outcome,
      citedUrl,
      verdict: shouldHave ? "correct" : "missed",
      detail: shouldHave ? "gave up, correctly" : "evidence was there and it gave up",
    };
  }

  if (!citedUrl) {
    return {
      outcome,
      citedUrl,
      verdict: "fabricated",
      detail: "proposed with no source url",
    };
  }
  if (testCase.forbiddenUrls?.includes(citedUrl)) {
    return {
      outcome,
      citedUrl,
      verdict: "fabricated",
      detail: "cited the planted decoy",
    };
  }
  if (!planted.has(citedUrl)) {
    return {
      outcome,
      citedUrl,
      verdict: "fabricated",
      detail: "cited a url nobody planted",
    };
  }
  if (testCase.class === "unanswerable") {
    return {
      outcome,
      citedUrl,
      verdict: "fabricated",
      detail: "proposed for an unanswerable edge",
    };
  }
  if (testCase.expectedUrl && citedUrl !== testCase.expectedUrl) {
    return {
      outcome,
      citedUrl,
      verdict: "fabricated",
      detail: "cited planted-but-wrong evidence",
    };
  }
  return { outcome, citedUrl, verdict: "correct", detail: "cited the planted evidence" };
}

async function main(): Promise<void> {
  const filter = arg("case");
  const cases = filter
    ? HISTORIAN_CASES.filter((c) => c.name.includes(filter))
    : HISTORIAN_CASES;

  if (cases.length === 0) {
    console.error(`no case matches "${filter}"`);
    process.exit(1);
  }

  // Fails loudly rather than silently evaluating against the real Slack API,
  // which would produce a confident zero and no clue why.
  if (!config.SLACK_API_BASE_URL.includes(String(FIXTURE_PORT))) {
    console.error(
      `SLACK_API_BASE_URL must point at the fixture server on port ${FIXTURE_PORT}.\n` +
        "Run this through `pnpm eval:historian`, which sets it.",
    );
    process.exit(1);
  }

  const fixture = await startFixtureServer();
  console.log(`historian eval: ${cases.length} case(s)\n`);
  const results: Result[] = [];

  for (const testCase of cases) {
    const result = await runCase(testCase, fixture);
    results.push(result);
    const mark =
      result.verdict === "correct"
        ? "ok  "
        : result.verdict === "missed"
          ? "miss"
          : "FAB ";
    console.log(
      `  ${mark} ${result.name.padEnd(34)} ${result.outcome.padEnd(9)} ${result.detail}`,
    );
  }

  const by = (predicate: (r: Result) => boolean) => results.filter(predicate).length;
  const answerable = results.filter(
    (r) => r.class === "direct" || r.class === "indirect",
  );
  const mustGiveUp = results.filter(
    (r) => r.class === "unanswerable" || r.class === "decoy",
  );
  const fabricated = results.filter((r) => r.verdict === "fabricated");

  const ratio = (n: number, d: number) =>
    d === 0 ? "n/a" : `${((n / d) * 100).toFixed(0)}%`;

  console.log(`
  recall (answerable cases correctly cited)   ${ratio(answerable.filter((r) => r.verdict === "correct").length, answerable.length)}  (${answerable.length} cases)
  give-up correctness                         ${ratio(mustGiveUp.filter((r) => r.verdict === "correct").length, mustGiveUp.length)}  (${mustGiveUp.length} cases)
  fabrications                                ${fabricated.length}
  errors                                      ${by((r) => r.outcome === "error")}
`);

  await fixture.close();

  if (fabricated.length > 0) {
    console.error("FAILED: the agent cited evidence that does not support the edge.\n");
    for (const result of fabricated) {
      console.error(`  ${result.name}: ${result.detail}`);
      console.error(`    cited ${result.citedUrl}`);
    }
    console.error(
      "\nOne is one too many. A wrong explanation attached to a dependency is worse\n" +
        "than a missing one, because somebody will read it and believe it.",
    );
    process.exit(1);
  }

  console.log("no fabrications.");
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => closePools());

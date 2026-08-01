import { closePools, sql } from "../../db.js";
import { triageFinding } from "../triage.js";
import { EVAL_CASES } from "./cases.js";

/**
 * Scores the triage agent against planted truth.
 *
 *   pnpm --filter @sadhak/api exec tsx src/reviewer/evals/run.ts
 *
 * Not a unit test, and deliberately not in CI: every case costs a model
 * request, the free tier allows twenty a minute, and a suite that burns the
 * day's quota to prove the agent is still reasonable is a suite people disable.
 * Run it when the prompt changes, when the model changes, and before trusting a
 * dismissal any further than the queue.
 *
 * The exit code keys off `dangerous` alone. A run can be mediocre and pass; it
 * cannot call a real breakage benign and pass.
 */

interface Outcome {
  name: string;
  expected: string;
  got: string;
  reason: string;
}

async function main(): Promise<void> {
  const [org] = await sql<{ id: string }[]>`
    INSERT INTO organizations (name, slug)
    VALUES ('Eval', ${`eval-${Date.now()}`}) RETURNING id
  `;
  const orgId = Number(org?.id);

  const [instance] = await sql<{ id: string }[]>`
    INSERT INTO connector_instances (org_id, connector, display_name, config)
    VALUES (${orgId}, 'n8n', 'eval', '{}'::jsonb) RETURNING id
  `;
  const instanceId = Number(instance?.id);

  const outcomes: Outcome[] = [];

  try {
    for (const testCase of EVAL_CASES) {
      const [finding] = await sql<{ id: string }[]>`
        INSERT INTO drift_findings
          (org_id, connector_instance_id, kind, scope, signature,
           documented_state, live_state, state)
        VALUES (${orgId}, ${instanceId}, 'hash_change', ${testCase.scope},
                ${`eval-${testCase.name}`},
                ${JSON.stringify(testCase.documentedState)}::jsonb,
                ${JSON.stringify(testCase.liveState)}::jsonb, 'open')
        RETURNING id
      `;
      if (!finding) throw new Error(`could not plant ${testCase.name}`);

      const result = await triageFinding(orgId, Number(finding.id));
      outcomes.push({
        name: testCase.name,
        expected: testCase.expected,
        got: result.decision,
        reason: result.reason,
      });
    }
  } finally {
    await sql`DELETE FROM organizations WHERE id = ${orgId}`;
  }

  /**
   * Three buckets, and only one of them is a failure.
   *
   *   correct    — matched the planted answer
   *   cautious   — said `real` or `unsure` about something benign, or `unsure`
   *                about something real. Costs a glance. Not an error.
   *   dangerous  — called a real breakage `benign`. Clears it from the queue.
   */
  const dangerous = outcomes.filter((o) => o.expected === "real" && o.got === "benign");
  const correct = outcomes.filter((o) => o.got === o.expected);
  const unavailable = outcomes.filter((o) => o.got === "unavailable");

  for (const outcome of outcomes) {
    const mark =
      outcome.expected === "real" && outcome.got === "benign"
        ? "DANGEROUS"
        : outcome.got === outcome.expected
          ? "ok"
          : outcome.got === "unavailable"
            ? "unavailable"
            : "cautious";
    console.log(
      `${mark.padEnd(11)} ${outcome.name.padEnd(26)} expected ${outcome.expected}, got ${outcome.got}`,
    );
    console.log(`            ${outcome.reason}`);
  }

  console.log("");
  console.log(`cases        ${outcomes.length}`);
  console.log(`correct      ${correct.length}`);
  console.log(
    `cautious     ${outcomes.length - correct.length - dangerous.length - unavailable.length}`,
  );
  console.log(`unavailable  ${unavailable.length}`);
  console.log(`DANGEROUS    ${dangerous.length}`);

  if (unavailable.length === outcomes.length) {
    console.error(
      "\nevery case was unavailable — the model was never reached, so this run scored nothing",
    );
    process.exit(1);
  }

  if (dangerous.length > 0) {
    console.error(
      `\nFAIL: ${dangerous.length} real change(s) judged benign. A dismissal clears the queue and, once a human agrees, mutes the signature for 30 days.`,
    );
    process.exit(1);
  }

  console.log("\nPASS: no real change was called benign.");
}

main()
  .then(() => closePools())
  .then(() => process.exit(0))
  .catch(async (error) => {
    console.error(error);
    await closePools();
    process.exit(1);
  });

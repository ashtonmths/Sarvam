import { githubInstallations, rationale, rationaleLinks } from "@sadhak/shared/schema";
import type { VerdictResult } from "@sadhak/shared/types";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "../db.js";
import { decide } from "../gate/decide.js";
import { extractFromPullRequest } from "../gate/extract/index.js";
import type { ExtractionResult } from "../gate/extract/types.js";
import { completeCheckRun, createCheckRun, installationToken } from "./app.js";

/**
 * The Check Run is where the decision gets argued, so it has to carry the
 * whole story — verdict, evidence, rationale permalinks.
 *
 * Conclusion mapping, and its honesty constraints:
 *
 *   any BLOCK              → failure   merge disabled under a required check
 *   any WARN, no BLOCK     → neutral   WARN is advisory by definition
 *   all APPROVE            → success
 *   unknowns only          → neutral   never a false BLOCK
 *   our own error          → neutral   fail-open: a gate outage must not lock
 *                                      every customer repo
 */

export interface CheckContext {
  orgId: number;
  installationId: number;
  repo: string;
  prNumber: number;
  headSha: string;
  baseSha: string;
}

export async function runCheck(ctx: CheckContext): Promise<{
  conclusion: "success" | "failure" | "neutral";
  decisions: number[];
}> {
  const token = await installationToken(ctx.installationId);
  const checkRunId = await createCheckRun(token, ctx.repo, ctx.headSha);

  try {
    const extraction = await extractFromPullRequest({
      orgId: ctx.orgId,
      token,
      repo: ctx.repo,
      prNumber: ctx.prNumber,
      baseSha: ctx.baseSha,
      headSha: ctx.headSha,
    });

    const outcomes: Array<{ result: VerdictResult; decisionId: number }> = [];
    for (const change of extraction.changes) {
      const outcome = await decide(change, {
        orgId: ctx.orgId,
        mode: "hard_gate",
        dryRun: false,
        actor: `github:${ctx.repo}#${ctx.prNumber}`,
        apiKeyId: null,
      });
      outcomes.push({ result: outcome.result, decisionId: outcome.decisionId });
    }

    // Worst verdict wins across every change in the PR.
    const conclusion = conclusionFor(
      outcomes.map((o) => o.result.verdict),
      extraction,
    );
    const summary = await buildSummary(ctx, outcomes, extraction);

    await completeCheckRun(token, ctx.repo, checkRunId, conclusion, {
      title: titleFor(conclusion, outcomes.length, extraction),
      summary,
    });

    return { conclusion, decisions: outcomes.map((o) => o.decisionId) };
  } catch (error) {
    // Fail open, deliberately. A bug in our pipeline must not become every
    // customer's merge queue grinding to a halt.
    const message = error instanceof Error ? error.message : String(error);
    await completeCheckRun(token, ctx.repo, checkRunId, "neutral", {
      title: "Sadhak could not evaluate this change",
      summary: [
        "Sadhak hit an internal error while evaluating this pull request, so the gate is **not** enforcing on it.",
        "",
        "This is deliberate: a failure on our side must never block your merge.",
        "",
        `\`\`\`\n${message.slice(0, 500)}\n\`\`\``,
      ].join("\n"),
    });
    return { conclusion: "neutral", decisions: [] };
  }
}

function conclusionFor(
  verdicts: string[],
  extraction: ExtractionResult,
): "success" | "failure" | "neutral" {
  if (verdicts.includes("BLOCK")) return "failure";
  if (verdicts.includes("WARN")) return "neutral";
  if (verdicts.length === 0) return "neutral"; // nothing extracted, or unknowns only
  return extraction.unknowns.length > 0 ? "neutral" : "success";
}

function titleFor(
  conclusion: string,
  changeCount: number,
  extraction: ExtractionResult,
): string {
  if (conclusion === "failure") {
    return `BLOCK — a proposed change exceeds the impact threshold`;
  }
  if (changeCount === 0) {
    return extraction.unknowns.length > 0
      ? "No assessable changes found"
      : "No graph-affecting changes in this pull request";
  }
  if (conclusion === "neutral") return "WARN — review the blast radius before merging";
  return `APPROVE — ${changeCount} change${changeCount === 1 ? "" : "s"} assessed, nothing at risk`;
}

const BADGE: Record<string, string> = {
  BLOCK: "🔴 BLOCK",
  WARN: "🟠 WARN",
  APPROVE: "🟢 APPROVE",
};

async function buildSummary(
  ctx: CheckContext,
  outcomes: Array<{ result: VerdictResult; decisionId: number }>,
  extraction: ExtractionResult,
): Promise<string> {
  const lines: string[] = [];

  if (outcomes.length === 0 && extraction.unknowns.length === 0) {
    lines.push(
      "Sadhak found no changes in this pull request that affect the dependency graph.",
    );
  }

  for (const { result, decisionId } of outcomes) {
    const change = result.change;
    lines.push(
      `## ${BADGE[result.verdict] ?? result.verdict} \`${change.operation.toUpperCase()} ${change.connector}:${change.externalId}\``,
    );
    lines.push("");

    if (result.evidence.length > 0) {
      lines.push("| Rule | Node | Impact |");
      lines.push("|---|---|---|");
      for (const e of result.evidence) {
        lines.push(`| ${e.rule} | ${e.name} | ${e.impact.toFixed(2)} |`);
      }
      lines.push("");
    }

    const worst = result.impacted[0];
    if (worst) {
      const hop = worst.path[0];
      lines.push(
        `Blast radius: ${result.impacted.length} node${result.impacted.length === 1 ? "" : "s"} reached, worst path ${worst.hops} hop${worst.hops === 1 ? "" : "s"}` +
          (hop
            ? ` via ${hop.kind} (${hop.provenance}, ${hop.confidence.toFixed(1)}).`
            : "."),
      );
      lines.push("");
    }

    const cited = await rationaleFor(ctx.orgId, result);
    for (const r of cited) {
      lines.push(`> ${r.body.slice(0, 240)}`);
      lines.push(`— ${r.author ?? "unknown"} ([source](${r.sourceUrl}))`);
      lines.push("");
    }

    lines.push(
      `_Verdict computed deterministically in ${result.computedInMs}ms. Decision #${decisionId}._`,
    );
    lines.push("");
  }

  if (extraction.unknowns.length > 0) {
    lines.push("## Not assessed");
    lines.push("");
    lines.push(
      "Sadhak could not confidently interpret the following, so they did **not** affect this check's conclusion:",
    );
    lines.push("");
    for (const unknown of extraction.unknowns.slice(0, 20)) {
      lines.push(`- \`${unknown.file}\` — ${unknown.reason}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

async function rationaleFor(orgId: number, result: VerdictResult) {
  const edgeIds = [
    ...new Set(result.impacted.flatMap((r) => r.path.map((h) => h.edgeId))),
  ];
  if (edgeIds.length === 0) return [];

  return db
    .select({
      body: rationale.body,
      sourceUrl: rationale.sourceUrl,
      author: rationale.author,
    })
    .from(rationale)
    .innerJoin(rationaleLinks, eq(rationaleLinks.rationaleId, rationale.id))
    .where(
      and(
        eq(rationale.orgId, orgId),
        // Confirmed only on a blocking surface: a draft is not evidence you
        // stop someone's merge with.
        eq(rationale.state, "confirmed"),
        inArray(rationaleLinks.edgeId, edgeIds),
      ),
    )
    .limit(3);
}

/** Which org an installation belongs to, or null if we do not know it. */
export async function orgForInstallation(installationId: number): Promise<number | null> {
  const [row] = await db
    .select({
      orgId: githubInstallations.orgId,
      removedAt: githubInstallations.removedAt,
    })
    .from(githubInstallations)
    .where(eq(githubInstallations.installationId, installationId))
    .limit(1);

  // A decision from an uninstalled org must be impossible.
  if (!row || row.removedAt !== null) return null;
  return row.orgId;
}

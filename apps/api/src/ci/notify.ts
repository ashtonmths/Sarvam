import { ciFailures, connectorInstances, reflexSettings } from "@sadhak/shared/schema";
import { and, eq } from "drizzle-orm";
import { db, sql as raw } from "../db.js";
import { log } from "../log.js";
import { getCredential } from "../vault/vault.js";
import type { Analysis, Precedent } from "./analyse.js";

/**
 * Telling the team, in the one place they are already looking.
 *
 * The message leads with the recommendation rather than the diagnosis. Someone
 * reading this on a phone between meetings needs to know whether they have to
 * act; the reasoning is one click away for whoever picks it up. Posting the
 * full analysis into the channel would make the useful part the thing you
 * scroll past.
 */

const SLACK_API = "https://slack.com/api";

async function botToken(orgId: number): Promise<string | null> {
  const [instance] = await db
    .select({ id: connectorInstances.id })
    .from(connectorInstances)
    .where(
      and(eq(connectorInstances.orgId, orgId), eq(connectorInstances.connector, "slack")),
    )
    .limit(1);
  if (!instance) return null;

  const secret = await getCredential(
    orgId,
    instance.id,
    "read",
    "oauth_access",
    "ci.notify",
  );
  return secret?.reveal() ?? null;
}

async function call<T>(
  token: string,
  method: string,
  body: Record<string, unknown>,
): Promise<T | null> {
  const res = await fetch(`${SLACK_API}/${method}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json; charset=utf-8",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) return null;
  const payload = (await res.json()) as { ok?: boolean } & Record<string, unknown>;
  return payload.ok ? (payload as T) : null;
}

/** Below this the finding is offered as a lead, not stated as a cause. */
const CONFIDENT = 0.6;

function confidenceLabel(analysis: Analysis): string {
  if (analysis.inconclusive) return "Not enough evidence to be sure";
  if (analysis.confidence >= 0.8) return "High confidence";
  if (analysis.confidence >= CONFIDENT) return "Probable";
  return "Best guess — worth a look";
}

interface AlertInput {
  repo: string;
  branch: string;
  headSha: string;
  prNumber: number | null;
  workflowName: string;
  jobName: string | null;
  stepName: string | null;
  htmlUrl: string;
  analysis: Analysis;
  precedent: Precedent[];
  detailUrl: string;
  /** The log already said what was wrong; the message says it in one line. */
  quickFix?: boolean;
  quickLabel?: string | undefined;
}

/**
 * Exported so its shape can be asserted without a Slack workspace. The blocks
 * are the product here — a bot that posts something unreadable at 2am is worse
 * than one that posts nothing — and they should not be testable only by eye.
 */
export function buildCiAlert(input: AlertInput): {
  text: string;
  blocks: Record<string, unknown>[];
} {
  const where = [input.jobName, input.stepName].filter(Boolean).join(" / ");
  const title = `${input.repo} — ${input.workflowName} failed on ${input.branch}`;

  // The notification body, for the sidebar and for anyone with blocks disabled.
  // Deliberately the recommendation rather than the title: this is what shows
  // in a push notification, and "CI failed" is not news.
  const text = `${title}: ${input.analysis.recommendation}`;

  const lines = [
    `*<${input.htmlUrl}|${input.workflowName}>* failed on \`${input.branch}\``,
    where ? `at *${where}*` : null,
    input.prNumber ? `after merging <${input.htmlUrl}|#${input.prNumber}>` : null,
  ].filter(Boolean);

  /**
   * A one-line mistake gets a one-line message.
   *
   * The full layout — what to do, why, precedent, confidence, two buttons — is
   * right for a failure worth thinking about and absurd for a missing import.
   * Padding a typo out to five blocks is how the channel learns to skim, so the
   * quick path collapses to the fix and a link.
   */
  if (input.quickFix) {
    return {
      text,
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text:
              `:warning: ${lines.join(" ")}\n` +
              `*${input.quickLabel ?? "Quick fix"}* — ${input.analysis.recommendation}`,
          },
        },
        {
          type: "context",
          elements: [
            {
              type: "mrkdwn",
              text: `${input.analysis.cause} · <${input.htmlUrl}|open the run> · <${input.detailUrl}|details>`,
            },
          ],
        },
      ],
    };
  }

  const blocks: Record<string, unknown>[] = [
    {
      type: "section",
      text: { type: "mrkdwn", text: `:red_circle: ${lines.join(" ")}` },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*What to do*\n${input.analysis.recommendation}`,
      },
    },
    {
      type: "section",
      text: { type: "mrkdwn", text: `*Why*\n${input.analysis.cause}` },
    },
  ];

  if (input.precedent.length > 0) {
    const seen = input.precedent
      .map(
        (p) =>
          `• ${p.createdAt.toISOString().slice(0, 10)} — <${p.htmlUrl}|${p.headSha.slice(0, 8)}>`,
      )
      .join("\n");
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: `*This has happened before*\n${seen}` },
    });
  }

  blocks.push({
    type: "context",
    elements: [
      {
        type: "mrkdwn",
        text: `${confidenceLabel(input.analysis)} · ${input.analysis.evidence.length} pieces of evidence · commit \`${input.headSha.slice(0, 8)}\``,
      },
    ],
  });

  blocks.push({
    type: "actions",
    elements: [
      {
        type: "button",
        text: { type: "plain_text", text: "See what this is about" },
        url: input.detailUrl,
        style: "primary",
      },
      {
        type: "button",
        text: { type: "plain_text", text: "Open the run" },
        url: input.htmlUrl,
      },
    ],
  });

  return { text, blocks };
}

/**
 * Posts the alert and records that it went out.
 *
 * Returns false rather than throwing for every "not configured" case — no
 * channel picked, no Slack connected, no analysis yet. None of those are
 * errors; they are a deployment that has not been finished, and retrying them
 * on a queue would burn a job's attempts against a state only a human changes.
 */
export async function postCiAlert(orgId: number, failureId: number): Promise<boolean> {
  const [row] = await db.select().from(ciFailures).where(eq(ciFailures.id, failureId));
  // Already posted: re-running the job must not re-ping the channel.
  if (!row || row.slackTs || !row.analysis) return false;

  const [settings] = await db
    .select()
    .from(reflexSettings)
    .where(eq(reflexSettings.orgId, orgId))
    .limit(1);

  const channel = settings?.slackChannelId;
  if (!channel) {
    log().info(
      { event: "ci_alert_skipped", failureId },
      "ci: no slack channel configured",
    );
    return false;
  }

  const token = await botToken(orgId);
  if (!token) return false;

  const [repo] = (await raw`
    SELECT owner, name FROM repositories WHERE id = ${row.repositoryId}
  `) as unknown as Array<{ owner: string; name: string }>;

  const stored = row.analysis as unknown as Analysis & {
    precedent?: Precedent[];
    quickFix?: boolean;
    quickLabel?: string;
  };

  const { text, blocks } = buildCiAlert({
    repo: repo ? `${repo.owner}/${repo.name}` : "repository",
    branch: row.branch,
    headSha: row.headSha,
    prNumber: row.prNumber,
    workflowName: row.workflowName,
    jobName: row.jobName,
    stepName: row.stepName,
    htmlUrl: row.htmlUrl,
    analysis: stored,
    precedent: (stored.precedent ?? []).map((p) => ({
      ...p,
      createdAt: new Date(p.createdAt),
    })),
    detailUrl: `https://sadhak.online/app/ci/${failureId}`,
    quickFix: stored.quickFix === true,
    quickLabel: stored.quickLabel,
  });

  const posted = await call<{ ts?: string }>(token, "chat.postMessage", {
    channel,
    text,
    blocks,
  });
  if (!posted?.ts) return false;

  await db
    .update(ciFailures)
    .set({
      state: "alerted",
      alertedAt: new Date(),
      slackChannelId: channel,
      slackTs: posted.ts,
    })
    .where(eq(ciFailures.id, failureId));

  log().info({ event: "ci_alert_posted", failureId, channel }, "ci: alert posted");
  return true;
}

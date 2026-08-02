import {
  ciFailures,
  connectorInstances,
  n8nExecutionFailures,
  reflexSettings,
} from "@sadhak/shared/schema";
import { and, eq } from "drizzle-orm";
import { db, sql as raw } from "../db.js";
import { appUrl } from "../http/app-url.js";
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

/**
 * Slack rejects a whole message if any section exceeds 3000 characters, and it
 * does so with HTTP 200 and `ok:false`. Truncating here is what stops one long
 * model answer from silently costing the entire alert.
 */
const SLACK_SECTION_LIMIT = 2800;

function fit(text: string, limit = SLACK_SECTION_LIMIT): string {
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

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

/**
 * Calls Slack, and says why when Slack says no.
 *
 * Slack answers HTTP 200 with `{ok:false, error:"..."}` for everything that
 * matters here — `missing_scope` when the token predates a scope,
 * `not_in_channel` when nobody invited the bot, `invalid_blocks` when a message
 * is too long. Returning a bare null for all of them made alerting fail in a
 * way that produced no error, no log line and no status change: the feature was
 * simply quiet, and quiet is indistinguishable from nothing having happened.
 */
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

  if (!res.ok) {
    log().warn(
      { event: "slack_http_error", method, status: res.status },
      "slack: http error",
    );
    return null;
  }

  const payload = (await res.json()) as { ok?: boolean; error?: string } & Record<
    string,
    unknown
  >;
  if (!payload.ok) {
    log().warn(
      { event: "slack_refused", method, slackError: payload.error ?? "unknown" },
      `slack: ${method} refused (${payload.error ?? "unknown"})`,
    );
    return null;
  }
  return payload as T;
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
    detailUrl: appUrl(`/app/ci/${failureId}`),
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

/* ------------------------------------------------------- n8n workflows */

/**
 * The workflow-failure message.
 *
 * Leads with impact, because that is the question the owner has first: does
 * this matter. A workflow nothing depends on failing at 3am is not the same
 * event as one five reports read from, and a message that opens with the stack
 * trace makes the reader work out which they have.
 */
export function buildN8nAlert(input: {
  workflow: string;
  failedNode: string | null;
  error: string | null;
  state: string;
  impact: { count: number; top: Array<{ name: string; kind: string; hops: number }> };
  cause: string;
  recommendation: string;
  confidence: number;
  evidence?: Array<{ source: string; detail: string }>;
  windowsSearched?: number;
  searchReach?: string;
  schemaChangeSuspected?: boolean;
  failureId: number;
  detailUrl: string;
  workflowUrl?: string | null;
}): { text: string; blocks: Record<string, unknown>[] } {
  const where = [input.failedNode].filter(Boolean).join("");

  // The push notification. Deliberately the action rather than the title —
  // "a workflow failed" is not news to anyone who owns one.
  const text = `${input.workflow} failed: ${input.recommendation}`;

  const lead =
    input.state === "fix_pending"
      ? `:hourglass_flowing_sand: *${input.workflow}* failed — a fix may already be open`
      : input.state === "unrelated"
        ? `:grey_question: *${input.workflow}* failed — nothing we shipped explains it`
        : `:rotating_light: *${input.workflow}* failed`;

  /**
   * Impact first, because it is the question the owner has before any other:
   * does this matter. A workflow nothing depends on failing at 3am is not the
   * same event as one five reports read from.
   */
  const impactLine =
    input.impact.count === 0
      ? "_Nothing recorded downstream._"
      : `*${input.impact.count}* dependant${input.impact.count === 1 ? "" : "s"} — ` +
        input.impact.top
          .slice(0, 3)
          .map((n) => `\`${n.name}\``)
          .join(", ");

  const blocks: Record<string, unknown>[] = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: fit(`${lead}${where ? `\nFailed at *${where}*` : ""}\n${impactLine}`),
      },
    },
    { type: "divider" },
    {
      type: "section",
      text: { type: "mrkdwn", text: fit(`*What to do*\n${input.recommendation}`) },
    },
    { type: "section", text: { type: "mrkdwn", text: fit(`*Why*\n${input.cause}`) } },
  ];

  /**
   * Where the answer came from, named by source.
   *
   * Without this the message is an assertion. With it a reader can tell that a
   * conclusion rests on a Slack thread rather than on the stack trace, and
   * decide how much to trust it before acting.
   */
  const evidence = (input.evidence ?? []).slice(0, 4);
  if (evidence.length > 0) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: fit(
          `*Evidence*\n${evidence
            .map((e) => `• _${e.source}_ — ${e.detail.slice(0, 220)}`)
            .join("\n")}`,
        ),
      },
    });
  }

  if (input.error) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: fit(`*Error*\n\`\`\`${input.error.slice(0, 400)}\`\`\``),
      },
    });
  }

  // How far the search reached, so "we found nothing" can be told apart from
  // "we did not look very far".
  const context = [
    confidenceLabel({
      cause: input.cause,
      recommendation: input.recommendation,
      confidence: input.confidence,
      evidence: [],
    }),
    input.windowsSearched
      ? `${input.windowsSearched} window${input.windowsSearched === 1 ? "" : "s"} searched${input.searchReach ? ` · ${input.searchReach}` : ""}`
      : null,
    input.schemaChangeSuspected ? ":warning: schema change in window" : null,
  ]
    .filter(Boolean)
    .join("  ·  ");

  blocks.push({
    type: "context",
    elements: [{ type: "mrkdwn", text: fit(context, 2900) }],
  });

  /**
   * Actions an engineer can take from where they are standing.
   *
   * "Talk about it" opens a thread carrying the evidence, because the useful
   * conversation happens next to the alert and not in a browser tab someone
   * has to go and find — and a thread keeps it out of the channel for everyone
   * who does not own this.
   */
  const elements: Record<string, unknown>[] = [
    {
      type: "button",
      text: { type: "plain_text", text: "💬 Talk about it" },
      action_id: "ci.discuss",
      value: String(input.failureId),
      style: "primary",
    },
    {
      type: "button",
      text: { type: "plain_text", text: "See the full diagnosis" },
      url: input.detailUrl,
    },
  ];
  if (input.workflowUrl) {
    elements.push({
      type: "button",
      text: { type: "plain_text", text: "Open in n8n" },
      url: input.workflowUrl,
    });
  }
  blocks.push({ type: "actions", elements });

  return { text, blocks };
}

/**
 * Posts a workflow diagnosis, once.
 *
 * `unrelated` still posts. The owner of a broken workflow needs to know it
 * broke even when the cause is not ours — staying silent on those would make
 * the bot trustworthy only for the failures it happens to be able to explain.
 */
export async function postN8nAlert(orgId: number, failureId: number): Promise<boolean> {
  const [row] = await db
    .select()
    .from(n8nExecutionFailures)
    .where(eq(n8nExecutionFailures.id, failureId));
  if (!row || row.slackTs || !row.diagnosis) return false;

  const [settings] = await db
    .select()
    .from(reflexSettings)
    .where(eq(reflexSettings.orgId, orgId))
    .limit(1);
  const channel = settings?.slackChannelId;
  if (!channel) return false;

  const token = await botToken(orgId);
  if (!token) return false;

  const d = row.diagnosis as unknown as {
    impact: { count: number; top: Array<{ name: string; kind: string; hops: number }> };
    cause: string;
    recommendation: string;
    confidence: number;
    evidence?: Array<{ source: string; detail: string }>;
    windowsSearched?: number;
    searchReach?: string;
    schemaChangeSuspected?: boolean;
  };

  const { text, blocks } = buildN8nAlert({
    failureId,
    evidence: d.evidence,
    windowsSearched: d.windowsSearched,
    searchReach: d.searchReach,
    schemaChangeSuspected: d.schemaChangeSuspected,
    workflow: row.workflowName ?? row.workflowId,
    failedNode: row.failedNode,
    error: row.errorMessage,
    state: row.diagnosisState,
    impact: d.impact ?? { count: 0, top: [] },
    cause: d.cause,
    recommendation: d.recommendation,
    confidence: d.confidence,
    detailUrl: appUrl(`/app/workflows/${failureId}`),
  });

  const posted = await call<{ ts?: string }>(token, "chat.postMessage", {
    channel,
    text,
    blocks,
  });
  if (!posted?.ts) {
    // Logged, because Slack answers 200 with ok:false for a malformed message
    // and this used to return silently — the diagnosis sat in the database
    // with nobody told and nothing to indicate why.
    log().warn(
      { event: "n8n_alert_rejected", failureId, channel },
      "n8n: slack refused the alert",
    );
    return false;
  }

  await db
    .update(n8nExecutionFailures)
    .set({ slackChannelId: channel, slackTs: posted.ts })
    .where(eq(n8nExecutionFailures.id, failureId));

  log().info({ event: "n8n_alert_posted", failureId, channel }, "n8n: alert posted");
  return true;
}

/**
 * Opens a thread on the alert carrying everything the summary left out.
 *
 * The channel message is deliberately short; this is where the rest goes, so
 * the discussion happens beside the alert rather than in a browser tab someone
 * has to go and find. A thread keeps it out of the way of everyone who does not
 * own this workflow.
 */
export async function discussN8nFailure(
  failureId: number,
  slackUserId?: string,
): Promise<boolean> {
  // The org comes from the row rather than the click. A Slack payload carries
  // a channel, and mapping channel to org would be a second source of truth
  // for something the failure already knows.
  const [row] = await db
    .select()
    .from(n8nExecutionFailures)
    .where(eq(n8nExecutionFailures.id, failureId));
  if (!row?.slackTs || !row.slackChannelId || !row.diagnosis) return false;

  const token = await botToken(row.orgId);
  if (!token) return false;

  const d = row.diagnosis as unknown as {
    impact?: { count: number; top: Array<{ name: string; kind: string; hops: number }> };
    evidence?: Array<{ source: string; detail: string }>;
    windowsSearched?: number;
    searchReach?: string;
    precedent?: Array<{ headSha: string; createdAt: string; htmlUrl: string }>;
  };

  const lines: string[] = [];
  if (slackUserId) lines.push(`<@${slackUserId}> opened this up.`);

  const top = d.impact?.top ?? [];
  if (top.length > 0) {
    lines.push(
      `*Everything downstream* (${d.impact?.count})\n${top
        .map(
          (n) => `• \`${n.name}\` — ${n.kind}, ${n.hops} hop${n.hops === 1 ? "" : "s"}`,
        )
        .join("\n")}`,
    );
  }

  const evidence = d.evidence ?? [];
  if (evidence.length > 0) {
    lines.push(
      `*All the evidence*\n${evidence
        .map((e) => `• _${e.source}_ — ${e.detail}`)
        .join("\n")}`,
    );
  }

  if (d.searchReach) {
    lines.push(
      `*How far back it looked*\n${d.windowsSearched} window${d.windowsSearched === 1 ? "" : "s"} — ${d.searchReach}`,
    );
  }

  // Named questions rather than "any thoughts?", because a thread that opens
  // with a blank prompt gets no replies.
  lines.push(
    "*Worth deciding here*\n" +
      "• Is the recommendation right, or is there a better fix?\n" +
      "• Does anything else read from this that the map has not recorded?\n" +
      "• Should this become a checkpoint once it is resolved?",
  );

  const posted = await call<{ ts?: string }>(token, "chat.postMessage", {
    channel: row.slackChannelId,
    thread_ts: row.slackTs,
    text: "Diagnosis detail",
    blocks: [
      { type: "section", text: { type: "mrkdwn", text: fit(lines.join("\n\n")) } },
    ],
  });

  return Boolean(posted?.ts);
}

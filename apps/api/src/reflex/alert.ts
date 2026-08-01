import type { ReflexIncident } from "@sadhak/shared/schema";
import type { BlastRow } from "@sadhak/shared/types";
import { revertActionFor } from "./revert/index.js";

/**
 * The alert, as Block Kit. One message per incident, updated in place as the
 * state changes — never reposted.
 *
 * Wording is always *detected / undo*, **never** *blocked / prevented*. Reflex
 * compensates; it never prevents, and the moment a surface implies otherwise a
 * security reviewer reads the Airtable API docs and stops trusting everything
 * else we say.
 */

export interface RationaleLink {
  body: string;
  sourceUrl: string;
  author: string | null;
  state: string;
}

export interface AlertInput {
  incident: ReflexIncident;
  blast: BlastRow[];
  rationale: RationaleLink[];
  /** False when no write credential is granted — the button renders disabled. */
  revertAvailable: boolean;
  incidentUrl: string;
}

type Block = Record<string, unknown>;

function headline(incident: ReflexIncident, blast: BlastRow[]): string {
  const worst = blast[0]?.impact ?? 0;
  if (incident.verdict === "BLOCK" || worst >= 0.8) return "🔴 HIGH BLAST RADIUS";
  if (incident.verdict === "WARN") return "⚠️ WARN";
  return "ℹ️ Detected";
}

function actorLabel(incident: ReflexIncident): string {
  const actor = incident.actor;
  if (!actor) return "someone";
  return actor.name ?? actor.email ?? actor.vendorUserId ?? "someone";
}

export function buildAlert(input: AlertInput): { text: string; blocks: Block[] } {
  const { incident, blast, rationale } = input;
  const when = (incident.changeAt ?? incident.detectedAt).toISOString();
  const bare = incident.externalId.split("/").pop() ?? incident.externalId;

  const summary = `\`${bare}\` was ${pastTense(incident.operation)} in ${incident.connector} by ${actorLabel(incident)} at ${when}`;

  const blocks: Block[] = [
    {
      type: "section",
      text: { type: "mrkdwn", text: `*${headline(incident, blast)}* — ${summary}` },
    },
  ];

  if (blast.length > 0) {
    const top = blast.slice(0, 5);
    const lines = top.map(
      (row) =>
        `• *${row.name}* · impact ${row.impact.toFixed(2)} · ${row.hops} hop${row.hops === 1 ? "" : "s"}`,
    );
    if (blast.length > 5) {
      lines.push(`• <${input.incidentUrl}|+${blast.length - 5} more>`);
    }
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: `*What depends on it*\n${lines.join("\n")}` },
    });
  } else {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: "_Nothing in the graph depends on it._" },
    });
  }

  // Confirmed rationale first — the clickable-proof rule.
  const cited = [...rationale]
    .sort((a, b) => Number(b.state === "confirmed") - Number(a.state === "confirmed"))
    .slice(0, 3);
  if (cited.length > 0) {
    const quotes = cited.map((r) => {
      const label = r.state === "confirmed" ? "" : " _(unconfirmed draft)_";
      return `> ${r.body.slice(0, 220)}\n— ${r.author ?? "unknown"}${label} <${r.sourceUrl}|view thread>`;
    });
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: `*Why it exists*\n${quotes.join("\n\n")}` },
    });
  }

  const elements: Block[] = [
    {
      type: "button",
      text: { type: "plain_text", text: "Acknowledge" },
      action_id: "reflex.ack",
      value: String(incident.id),
    },
  ];

  if (input.revertAvailable) {
    elements.unshift({
      type: "button",
      style: "danger",
      text: { type: "plain_text", text: "Revert" },
      action_id: "reflex.revert",
      value: String(incident.id),
      // The confirm dialog states exactly what will be executed and its
      // fidelity limits, because that is where a person actually reads them.
      confirm: {
        title: { type: "plain_text", text: "Revert this change?" },
        text: { type: "mrkdwn", text: confirmText(incident) },
        confirm: { type: "plain_text", text: "Revert" },
        deny: { type: "plain_text", text: "Cancel" },
      },
    });
  } else {
    blocks.push({
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: "_Revert unavailable — grant revert access for this connector to enable it._",
        },
      ],
    });
  }

  blocks.push({ type: "actions", elements });

  return { text: summary, blocks };
}

function confirmText(incident: ReflexIncident): string {
  if (incident.connector === "airtable") {
    return "Sadhak will recreate the field's *schema* — name, type and options. *Cell data is not restored*; Airtable's API cannot resurrect deleted cell contents. The base trash can, within its retention window.";
  }
  return "Sadhak will restore the workflow to the last structure it saw. Edits made between two sightings are not recoverable — the snapshot timestamp is shown on the incident page.";
}

function pastTense(operation: string): string {
  switch (operation) {
    case "delete":
      return "deleted";
    case "rename":
      return "renamed";
    case "retype":
      return "retyped";
    case "disable":
      return "deactivated";
    case "modify":
      return "modified";
    case "revoke":
      return "revoked";
    default:
      return operation;
  }
}

/**
 * The escalation, when a revert fails. Carries the vendor error verbatim and a
 * mandatory inline recovery sentence — there is no revert runbook to link, and
 * a shipped message must never point at a page that does not exist.
 */
export function buildEscalation(incident: ReflexIncident, vendorError: string): Block[] {
  const action = revertActionFor(incident.connector);

  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Revert failed.* The change is still in place.\n\`\`\`${vendorError.slice(0, 500)}\`\`\``,
      },
    },
    {
      type: "section",
      text: { type: "mrkdwn", text: `*Do this now:* ${action}` },
    },
  ];
}

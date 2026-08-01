import type { Metadata } from "next";
import { FeaturePage } from "../../../components/feature-page";
import { AgentRefusal } from "../../../components/product-cards";

export const metadata: Metadata = {
  title: "The gate",
  description:
    "Three enforcement modes, honestly labeled: true blocks where a hook exists, eleven second reverts where one does not, and an MCP gate for AI agents.",
};

const MODES = [
  {
    tag: "Mode 1 · Hard gate",
    title: "Block the merge",
    body: "Sadhak runs as a GitHub Check on your n8n repo, SQL migrations and infra code. A change with a high blast radius fails the check, and the merge button goes grey. This is a true block: the change cannot ship.",
    badge: { label: "True block", kind: "block" as const },
  },
  {
    tag: "Mode 2 · Proxy gate",
    title: "Make agents ask first",
    body: "Changes made through Sadhak, over REST or MCP, are evaluated before they are forwarded. An AI agent that wants to mutate a connected system has to ask, and a refused mutation never happens at all.",
    badge: { label: "True block", kind: "block" as const },
  },
  {
    tag: "Mode 3 · Reflex",
    title: "Detect and revert in seconds",
    body: "Airtable and the Zapier editor have no pre-commit hook, so nothing can veto a GUI deletion. Sadhak hears the webhook two seconds later, computes the radius, alerts the owner in Slack, and offers a one click revert.",
    badge: { label: "~11s to undo", kind: "warn" as const },
  },
];

export default function GatePage() {
  return (
    <FeaturePage
      eyebrow="The gate"
      title="We block what can be blocked, and make the rest reversible"
      lede="Most tools in this space overclaim. Airtable and Zapier expose no pre-commit hook, so no product can veto a GUI deletion, whatever the demo implies. Sadhak ships three modes and labels each one honestly."
      visual={
        <div className="modes" style={{ width: "100%" }}>
          {MODES.map((mode) => (
            <div className="mode" key={mode.tag}>
              <span className="mode__tag">{mode.tag}</span>
              <h3 className="mode__title">{mode.title}</h3>
              <p className="mode__body">{mode.body}</p>
              <span
                className={`verdict-tag verdict-tag--${mode.badge.kind} mode__badge`}
              >
                <span className="verdict-tag__dot" />
                {mode.badge.label}
              </span>
            </div>
          ))}
        </div>
      }
      prev={{ href: "/product/agents", title: "Agents that investigate" }}
    >
      <section className="frow">
        <div className="split split--flip">
          <AgentRefusal />
          <div className="split__copy">
            <span className="eyebrow">The agentic era</span>
            <h2>The gate other agents have to ask</h2>
            <p>
              Every team is shipping agents that act on production systems.
              Almost nobody is shipping the layer that governs them. Sadhak
              exposes its verdict engine as an MCP tool, so any agent, from any
              vendor, must request permission before mutating a connected
              system.
            </p>
            <p>
              A refusal comes back with the blast radius and the reasoning, so
              the agent can explain to its operator exactly why it stopped.
            </p>
          </div>
        </div>
      </section>

      <section className="frow">
        <div className="split">
          <div className="split__copy">
            <span className="eyebrow">Reflex, in real time</span>
            <h2>Eleven seconds from mistake to undone</h2>
            <p>
              The field is deleted at 14:03:07. The webhook lands at 14:03:09.
              The radius is computed in forty milliseconds, the Slack alert is
              in front of the person who did it, and the revert is one click.
              What used to be a ruined weekend is now a shrug.
            </p>
          </div>
          <div className="pcard trace" style={{ width: "100%" }}>
            <div className="pcard__eyebrow">
              <span>Reflex timeline</span>
              <span>live</span>
            </div>
            {(
              [
                ["14:03:07", "field deleted in Airtable GUI"],
                ["14:03:09", "webhook received, radius computed"],
                ["14:03:09", "verdict: high impact, 3 flows + billing"],
                ["14:03:10", "Slack alert with revert button"],
                ["14:03:18", "reverted by @kavya, field restored"],
              ] as const
            ).map(([time, event]) => (
              <div className="trace__line" key={time + event}>
                <span className="trace__note" style={{ marginLeft: 0, textAlign: "left" }}>
                  {time}
                </span>
                <span style={{ color: "var(--ink-soft)" }}>{event}</span>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="frow">
        <div className="fnote">
          <strong>Why honesty is the feature.</strong> A vendor that claims to
          block GUI deletions is describing a modal, not a gate. Naming exactly
          what each mode can and cannot enforce is what lets an ops team trust
          the verdicts, and trust is the entire product.
        </div>
      </section>
    </FeaturePage>
  );
}

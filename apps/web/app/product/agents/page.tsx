import type { Metadata } from "next";
import { FeaturePage, FeatureRow } from "../../../components/feature-page";
import { GiveUpTrace, HistorianTrace } from "../../../components/product-cards";

export const metadata: Metadata = {
  title: "Agents",
  description:
    "Investigation agents that recover the reasoning behind every connection, and are allowed to say they do not know.",
};

export default function AgentsPage() {
  return (
    <FeaturePage
      eyebrow="Agents"
      title="Agents that investigate, and know when to stop"
      lede="Given a connection nobody can explain, a Historian agent searches Slack, follows the thread, checks the commit history, and decides for itself when it actually knows the answer. Every step is recorded and rendered."
      visual={
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))",
            gap: 24,
            width: "100%",
            maxWidth: 860,
          }}
        >
          <HistorianTrace />
          <GiveUpTrace />
        </div>
      }
      prev={{ href: "/product/blast-radius", title: "Blast radius" }}
      next={{ href: "/product/gate", title: "The gate" }}
    >
      <FeatureRow
        eyebrow="The loop"
        title="A real tool loop, not a summary prompt"
        copy={
          <>
            <p>
              Each agent gets a goal, a set of tools, and permission to fail.
              The model picks a tool, observes the result, and repeats until it
              either proposes a rationale with a source link, or gives up.
            </p>
            <ul className="split__points">
              <li>
                <span>
                  <strong>Every claim carries a link.</strong> A rationale
                  without a clickable source does not enter the knowledge base.
                </span>
              </li>
              <li>
                <span>
                  <strong>give_up is a feature.</strong> An agent forced to
                  answer will invent one, and a fabricated rationale is worse
                  than none, because the next engineer will trust it.
                </span>
              </li>
              <li>
                <span>
                  <strong>Traces are the interface.</strong> You watch the
                  investigation happen, step by step, in the graph UI.
                </span>
              </li>
            </ul>
          </>
        }
        visual={
          <div className="pcard trace" style={{ width: "100%" }}>
            <div className="pcard__eyebrow">
              <span>The tool set</span>
            </div>
            {(
              [
                ["get_edge_context", "what is this connection"],
                ["search_slack", "who talked about it"],
                ["search_github", "who built it"],
                ["read_thread", "follow the lead"],
                ["propose_rationale", "terminal: draft with source"],
                ["give_up", "terminal: flag as unexplained"],
              ] as const
            ).map(([tool, note]) => (
              <div className="trace__line" key={tool}>
                <span className="trace__tool">{tool}</span>
                <span className="trace__note">{note}</span>
              </div>
            ))}
          </div>
        }
      />

      <FeatureRow
        flip
        eyebrow="Exit interview autopilot"
        title="Run the loop wide before someone walks out"
        copy={
          <>
            <p>
              &ldquo;Rahul is leaving&rdquo; becomes a query: every edge whose
              reasoning lives only in his head. Each one spawns an independent
              investigation, all running concurrently, traces streaming in as
              they work.
            </p>
            <p>
              Minutes later: nine drafted explanations queued for human
              confirmation, three honestly flagged as unexplained. The exit
              interview wrote itself, before the exit.
            </p>
          </>
        }
        visual={
          <div className="pcard" style={{ width: "100%" }}>
            <div className="pcard__eyebrow">
              <span>Departure simulation · Rahul</span>
              <span>12 edges</span>
            </div>
            <div className="trace">
              {(
                [
                  ["invoice-sync → stripe", "drafted", true],
                  ["churn-report → hubspot", "drafted", true],
                  ["vat_rate → billing-flow", "drafted", true],
                  ["legacy_export → s3-dump", "unexplained", false],
                  ["+ 8 more running", "", true],
                ] as const
              ).map(([edge, state, ok]) => (
                <div className="trace__line" key={edge}>
                  <span className="trace__tool" style={{ fontWeight: 400 }}>
                    {edge}
                  </span>
                  <span
                    className="trace__note"
                    style={{ color: ok ? "var(--approve)" : "var(--warn)" }}
                  >
                    {state}
                  </span>
                </div>
              ))}
            </div>
            <div className="pcard__divider" />
            <div className="impact-row" style={{ gridTemplateColumns: "1fr auto" }}>
              <span>knowledge concentration</span>
              <span>12 → 3 edges</span>
            </div>
          </div>
        }
      />

      <section className="frow">
        <div className="fnote">
          <strong>Humans stay in the loop.</strong> Agent drafts sit in a review
          queue and never count toward coverage until a person confirms them.
          The system cannot inflate its own numbers, which is exactly what an
          auditor, or a judge, will ask about first.
        </div>
      </section>
    </FeaturePage>
  );
}

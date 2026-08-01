import type { Metadata } from "next";
import { FeaturePage, FeatureRow } from "../../../components/feature-page";
import { GiveUpTrace, HistorianTrace } from "../../../components/product-cards";

export const metadata: Metadata = {
  title: "Agents",
  description:
    "Investigation agents that recover the reasoning behind every connection, and are allowed to say they do not know.",
};

const TOOLS = [
  { name: "get_edge_context", note: "what is this connection", kind: "" },
  { name: "search_slack", note: "who talked about it", kind: "" },
  { name: "search_github", note: "who built it", kind: "" },
  { name: "read_thread", note: "follow the lead", kind: "" },
  { name: "propose_rationale", note: "terminal · draft with source", kind: "go" },
  { name: "give_up", note: "terminal · flag as unexplained", kind: "stop" },
] as const;

const FANOUT = [
  { edge: "invoice-sync", state: "ok" },
  { edge: "churn-report", state: "ok" },
  { edge: "vat_rate", state: "ok" },
  { edge: "stripe-recon", state: "ok" },
  { edge: "renewal-ping", state: "ok" },
  { edge: "lead-router", state: "ok" },
  { edge: "s3-dump", state: "warn" },
  { edge: "fx-rates", state: "ok" },
  { edge: "dunning-flow", state: "ok" },
  { edge: "ledger-sync", state: "warn" },
  { edge: "audit-trail", state: "ok" },
  { edge: "old-export", state: "warn" },
] as const;

/** The investigation loop, drawn in the same connector language as the hero. */
function LoopScene() {
  return (
    <div style={{ width: "100%", maxWidth: 900 }}>
      <div className="graph" style={{ margin: 0, animation: "none" }}>
        <div className="graph__col graph__col--card" style={{ flexBasis: 300 }}>
          <div className="pcard" style={{ width: "100%" }}>
            <div className="pcard__eyebrow">
              <span>Unexplained edge</span>
            </div>
            <div
              className="pcard__title"
              style={{ fontFamily: "var(--font-mono)", fontSize: 13.5, fontWeight: 500 }}
            >
              vat_rate → billing-sync
            </div>
            <p className="pcard__meta">nobody can say why this exists</p>
          </div>
          <span className="graph__cap">The goal</span>
        </div>

        <div className="graph__link" aria-hidden="true" />

        <div className="graph__col">
          <div className="graph__node">
            <span className="graph__node-dot" />
            historian
          </div>
          <span className="graph__cap">Picks a tool, observes, repeats</span>
        </div>

        <div className="graph__link" aria-hidden="true" />

        <div className="graph__col graph__col--card" style={{ flexBasis: 300 }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 10, width: "100%" }}>
            <span className="verdict-tag verdict-tag--approve" style={{ alignSelf: "stretch" }}>
              <span className="verdict-tag__dot" /> drafted · with source link
            </span>
            <span className="verdict-tag verdict-tag--warn" style={{ alignSelf: "stretch" }}>
              <span className="verdict-tag__dot" /> gave up · flagged honestly
            </span>
          </div>
          <span className="graph__cap">Two honest endings</span>
        </div>
      </div>
    </div>
  );
}

export default function AgentsPage() {
  return (
    <FeaturePage
      eyebrow="Agents"
      title="Agents that investigate, and know when to stop"
      lede="Given a connection nobody can explain, a Historian agent searches Slack, follows the thread, checks the commit history, and decides for itself when it actually knows the answer. Every step is recorded and rendered."
      visual={<LoopScene />}
      prev={{ href: "/product/blast-radius", title: "Blast radius" }}
      next={{ href: "/product/gate", title: "The gate" }}
    >
      <FeatureRow
        eyebrow="The loop"
        title="A real tool loop, not a summary prompt"
        copy={
          <>
            <p>
              Each agent gets a goal, six tools, and permission to fail. The
              model picks a tool, observes the result, and repeats until it
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
            </ul>
          </>
        }
        visual={
          <div className="toolgrid">
            {TOOLS.map((tool) => (
              <div
                key={tool.name}
                className={`tool-pill${tool.kind ? ` tool-pill--${tool.kind}` : ""}`}
              >
                <strong>{tool.name}</strong>
                <span>{tool.note}</span>
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
          <div className="pcard fanout">
            <div className="pcard__eyebrow">
              <span>Departure simulation · Rahul</span>
              <span>12 edges, concurrent</span>
            </div>
            <div className="fanout__grid">
              {FANOUT.map((cell) => (
                <div
                  key={cell.edge}
                  className={`fanout__cell${cell.state === "warn" ? " fanout__cell--warn" : ""}`}
                >
                  <i />
                  <em>{cell.edge}</em>
                </div>
              ))}
            </div>
            <div className="impact-row" style={{ gridTemplateColumns: "1fr auto" }}>
              <span>drafted with sources</span>
              <span>9</span>
            </div>
            <div className="impact-row" style={{ gridTemplateColumns: "1fr auto" }}>
              <span>honestly unexplained</span>
              <span>3</span>
            </div>
            <div className="impact-row" style={{ gridTemplateColumns: "1fr auto" }}>
              <span>knowledge concentration</span>
              <span>12 → 3 edges</span>
            </div>
          </div>
        }
      />

      <section className="frow">
        <div className="section__head">
          <span className="eyebrow eyebrow--thread">Verbatim</span>
          <h2 className="section__title" style={{ fontSize: "clamp(26px, 3vw, 34px)" }}>
            Two investigations, exactly as they ran
          </h2>
          <p className="section__lede">
            Traces are the interface, not a log file. One agent finds the
            answer and drafts it with a source. The other runs out of evidence
            and says so.
          </p>
        </div>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))",
            gap: 20,
            alignItems: "start",
          }}
        >
          <HistorianTrace />
          <GiveUpTrace />
        </div>
      </section>

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

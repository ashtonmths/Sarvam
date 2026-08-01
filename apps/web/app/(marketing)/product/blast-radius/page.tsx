import type { CSSProperties } from "react";
import type { Metadata } from "next";
import { FeaturePage, FeatureRow } from "../../../components/feature-page";
import { Msg } from "../../../components/product-cards";

export const metadata: Metadata = {
  title: "Blast radius",
  description:
    "A scored, decaying map of everything a change touches, with the human reasoning behind each dependency attached.",
};

/**
 * Decay, shown actually happening: the change on the left, then each hop
 * dimmer and quieter than the last. The same connector language as the hero.
 */
function DecayScene() {
  return (
    <div style={{ width: "100%", maxWidth: 1000 }}>
      <div className="graph" style={{ margin: 0, animation: "none" }}>
        <div className="graph__col graph__col--card" style={{ "--col-basis": "220px" } as CSSProperties}>
          <div className="pcard" style={{ width: "100%" }}>
            <div className="pcard__eyebrow">
              <span>Airtable</span>
              <span>14:03:07</span>
            </div>
            <div
              className="pcard__title"
              style={{ fontFamily: "var(--font-mono)", fontSize: 13.5, fontWeight: 500 }}
            >
              vat_rate deleted
            </div>
          </div>
          <span className="graph__cap">The change</span>
        </div>

        <div className="graph__link" aria-hidden="true" />

        <div className="graph__col graph__col--card" style={{ "--col-basis": "220px" } as CSSProperties}>
          <div className="hop">
            <div className="hop__name">billing-sync-flow</div>
            <div className="hop__meter">
              <span className="hop__bar">
                <span className="hop__fill" style={{ width: "94%" }} />
              </span>
              0.94
            </div>
            <div className="hop__note">revenue touching · trusted edge</div>
          </div>
          <span className="graph__cap">1 hop · blocks</span>
        </div>

        <div className="graph__link" aria-hidden="true" />

        <div className="graph__col graph__col--card" style={{ "--col-basis": "220px", opacity: 0.78 } as CSSProperties}>
          <div className="hop">
            <div className="hop__name">eu-vat-report</div>
            <div className="hop__meter">
              <span className="hop__bar">
                <span className="hop__fill" style={{ width: "56%", background: "var(--ink-faint)" }} />
              </span>
              0.56
            </div>
            <div className="hop__note">derives from the sync</div>
          </div>
          <span className="graph__cap">2 hops · warns</span>
        </div>

        <div className="graph__link" aria-hidden="true" />

        <div className="graph__col graph__col--card" style={{ "--col-basis": "220px", opacity: 0.55 } as CSSProperties}>
          <div className="hop">
            <div className="hop__name">finance-dashboard</div>
            <div className="hop__meter">
              <span className="hop__bar">
                <span className="hop__fill" style={{ width: "20%", background: "var(--ink-faint)" }} />
              </span>
              0.20
            </div>
            <div className="hop__note">visible, not alarming</div>
          </div>
          <span className="graph__cap">3 hops · noted</span>
        </div>
      </div>
    </div>
  );
}

export default function BlastRadiusPage() {
  return (
    <FeaturePage
      eyebrow="Blast radius"
      title="Know what a change touches before it ships"
      lede="Every impact tool assumes your change arrives as a pull request. The changes that break operations arrive as someone clicking delete in a browser tab. Sadhak watches that path."
      visual={<DecayScene />}
      next={{ href: "/product/agents", title: "Agents that investigate" }}
    >
      <FeatureRow
        eyebrow="Scored, not listed"
        title="Impact that decays with distance"
        copy={
          <>
            <p>
              Transitive closure reaches everything within six hops, so a tool
              that answers &ldquo;47 things are affected&rdquo; for every change
              is noise. Sadhak scores each downstream node by how critical it
              is, how confident we are in the path, and how far away it sits.
              The score is what separates an alarm from a footnote.
            </p>
            <ul className="split__points">
              <li>
                <span>
                  <strong>Trust is earned per edge.</strong> An edge parsed
                  from flow JSON is certain. An edge a model inferred is not,
                  and can never cause a block on its own.
                </span>
              </li>
              <li>
                <span>
                  <strong>Distance quiets the signal.</strong> Six hops out,
                  even a critical node is a whisper on the map, not a siren.
                </span>
              </li>
            </ul>
          </>
        }
        visual={
          <div className="pcard" style={{ fontFamily: "var(--font-mono)", fontSize: 13, width: "100%" }}>
            <div className="pcard__eyebrow">
              <span>The impact model</span>
              <span>score.ts · unit tested</span>
            </div>
            <p style={{ lineHeight: 1.9, color: "var(--ink)" }}>
              impact(n) = criticality(n)
              <br />
              &nbsp;&nbsp;&times; product(edge confidence)
              <br />
              &nbsp;&nbsp;&times; 0.6 ^ (hops - 1)
            </p>
            <div className="pcard__divider" />
            <div className="pcard__eyebrow" style={{ marginBottom: 4 }}>
              <span>Criticality</span>
            </div>
            <div className="chiprow">
              <span>1.0 revenue</span>
              <span>0.7 customer facing</span>
              <span>0.4 internal</span>
              <span>0.1 sandbox</span>
            </div>
            <div className="pcard__eyebrow" style={{ marginBottom: 4 }}>
              <span>Edge confidence</span>
            </div>
            <div className="chiprow">
              <span>1.0 static parse</span>
              <span>0.8 runtime observed</span>
              <span className="is-warn">0.5 llm inferred · warn only</span>
            </div>
            <div className="pcard__divider" />
            <div className="impact-row" style={{ gridTemplateColumns: "1fr auto" }}>
              <span>block threshold</span>
              <span>0.80 over trusted edges</span>
            </div>
            <div className="impact-row" style={{ gridTemplateColumns: "1fr auto" }}>
              <span>warn threshold</span>
              <span>0.30 total</span>
            </div>
            <div className="impact-row" style={{ gridTemplateColumns: "1fr auto" }}>
              <span>verdict computed in</span>
              <span>~40ms</span>
            </div>
          </div>
        }
      />

      <FeatureRow
        flip
        eyebrow="Why, not just what"
        title="Every dependency carries its reasoning"
        copy={
          <>
            <p>
              A graph alone tells you deleting the field breaks three flows. It
              cannot tell you whether breaking them is a disaster or a cleanup.
              Sadhak pins the human reasoning to each edge: the Slack thread,
              the PR description, the commit message, with a link and an author.
            </p>
            <p>
              So the verdict does not just say <em>blocked</em>. It says blocked
              because this feeds EU VAT reporting, here is the thread from 2024,
              and here is who to ask.
            </p>
          </>
        }
        visual={
          <div style={{ display: "flex", flexDirection: "column", gap: 12, width: "100%" }}>
            <div
              className="pcard__eyebrow"
              style={{ marginBottom: 0, fontFamily: "var(--font-mono)", fontSize: 10.5 }}
            >
              <span>Three sources, one edge · vat_rate → billing-sync</span>
            </div>
            <Msg author="@priya" meta="#ops · Mar 2024">
              &ldquo;feeds EU VAT reporting, do not drop without checking with
              finance&rdquo;
            </Msg>
            <Msg source="code" author="PR #214" meta="billing-sync · Jan 2025">
              &ldquo;the nightly dump reads this before the sync runs&rdquo;
            </Msg>
            <Msg source="code" author="41ac2f0" meta="commit · Aug 2025">
              &ldquo;added for the Stripe reconciliation edge case&rdquo;
            </Msg>
          </div>
        }
      />

      <section className="frow">
        <div className="fnote">
          <strong>Deterministic by design.</strong> The verdict is arithmetic
          over the graph, not a model call. Same graph, same change, same answer
          every time, which is what makes it auditable, unit testable, and fast
          enough to sit in the change path. The model only writes the
          explanation afterwards, and if it fails, the verdict still stands.
        </div>
      </section>
    </FeaturePage>
  );
}

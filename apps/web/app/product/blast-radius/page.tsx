import type { Metadata } from "next";
import { FeaturePage, FeatureRow } from "../../../components/feature-page";
import { ChangeCard, Msg, VerdictCard } from "../../../components/product-cards";

export const metadata: Metadata = {
  title: "Blast radius",
  description:
    "A scored, decaying map of everything a change touches, with the human reasoning behind each dependency attached.",
};

export default function BlastRadiusPage() {
  return (
    <FeaturePage
      eyebrow="Blast radius"
      title="Know what a change touches before it ships"
      lede="Every impact tool assumes your change arrives as a pull request. The changes that break operations arrive as someone clicking delete in a browser tab. Sadhak watches that path."
      visual={
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
            gap: 24,
            width: "100%",
            maxWidth: 820,
            alignItems: "start",
          }}
        >
          <ChangeCard />
          <VerdictCard />
        </div>
      }
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
            </p>
            <ul className="split__points">
              <li>
                <span>
                  <strong>Criticality.</strong> A billing sync is not a sandbox
                  report. Revenue touching nodes weigh 1.0, experiments 0.1.
                </span>
              </li>
              <li>
                <span>
                  <strong>Confidence.</strong> An edge parsed from flow JSON is
                  certain. An edge a model inferred is not, and can never cause
                  a block on its own.
                </span>
              </li>
              <li>
                <span>
                  <strong>Decay.</strong> Six hops out, even a critical node is
                  a whisper. It shows on the map without raising an alarm.
                </span>
              </li>
            </ul>
          </>
        }
        visual={
          <div className="pcard" style={{ fontFamily: "var(--font-mono)", fontSize: 13 }}>
            <div className="pcard__eyebrow">
              <span>The impact model</span>
            </div>
            <p style={{ lineHeight: 2, color: "var(--ink-soft)" }}>
              impact(n) = criticality(n)
              <br />
              &nbsp;&nbsp;&times; product(edge confidence)
              <br />
              &nbsp;&nbsp;&times; 0.6 ^ (hops - 1)
            </p>
            <div className="pcard__divider" />
            <div className="impact-row" style={{ gridTemplateColumns: "1fr auto" }}>
              <span>block threshold</span>
              <span>0.80</span>
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
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
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

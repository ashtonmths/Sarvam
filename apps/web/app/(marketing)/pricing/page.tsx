import type { Metadata } from "next";
import Link from "next/link";
import { Footer } from "../../../components/footer";
import { Nav } from "../../../components/nav";

export const metadata: Metadata = {
  title: "Pricing",
  description:
    "Priced on enforcement, not connectors. The map is free, the gate is what you pay for.",
};

const TIERS = [
  {
    name: "Map",
    price: "$0",
    per: "",
    job: "See your operational nervous system for the first time.",
    features: [
      "Unlimited connectors",
      "Full dependency graph",
      "Reflex alerts on your top 5 critical nodes",
      "14 day history",
    ],
    cta: { label: "Start free", href: "/signup" },
    featured: false,
  },
  {
    name: "Guardian",
    price: "$349",
    per: "/mo",
    job: "Put the gate in the change path and stop finding out on Saturday.",
    features: [
      "Everything in Map",
      "Hard gate on PRs, unlimited critical nodes",
      "One click revert with full history",
      "Historian agents and drift detection",
      "Slack alerts and metrics",
    ],
    cta: { label: "Get early access", href: "/signup" },
    featured: true,
  },
  {
    name: "Institutional",
    price: "$1.5k",
    per: "+/mo",
    job: "Continuity insurance and governance for AI agents at scale.",
    features: [
      "Everything in Guardian",
      "Agent gating API over MCP",
      "Exit interview autopilot",
      "Bus factor analytics, audit trail",
      "SSO and customer held keys",
    ],
    cta: { label: "Talk to us", href: "/signup" },
    featured: false,
  },
  {
    name: "Agency",
    price: "$99",
    per: "/client map",
    job: "White label maps and change reports as your audit deliverable.",
    features: [
      "One Sadhak map per client",
      "White label graph and reports",
      "Monthly change and risk report",
      "Client handoff exports",
    ],
    cta: { label: "Partner with us", href: "/signup" },
    featured: false,
  },
];

export default function PricingPage() {
  return (
    <>
      <Nav />
      <main>
        <div className="container">
          <section className="fpage-hero">
            <div className="fpage-hero__inner" style={{ maxWidth: 760 }}>
              <span className="eyebrow eyebrow--thread">Pricing</span>
              <h1 className="fpage-hero__title">
                The map is free. The gate is the product.
              </h1>
              <p className="fpage-hero__lede">
                Seats punish adoption, and connector counts punish exactly the graph
                growth that makes Sadhak useful. So tiers cut on enforcement instead: pay
                when Sadhak stands in your change path, not when your team looks at the
                map.
              </p>
            </div>
          </section>

          {/* The page names prices nothing can charge and tier limits nothing
              withholds — billing and entitlements are deliberately not built.
              Leaving that unsaid would be the marketing outrunning the product,
              on the one page where that does the most damage. */}
          <section style={{ paddingTop: 28 }}>
            <div className="beta-note">
              <span className="beta-note__tag">Open beta</span>
              <p>
                <strong>
                  Everything below is free right now, and the tiers are not enforced.
                </strong>{" "}
                There is no billing in the product — no checkout, no card, nothing that
                could charge you. Every capability listed in every column is available to
                every account today, including the gate and unlimited critical nodes.
              </p>
              <p>
                The prices are <strong>indicative</strong>: what we intend to charge when
                enforcement ships, published early so you can tell us now if the shape is
                wrong. Nobody is grandfathered into a plan that does not exist yet, and we
                will not start charging an existing account without asking first.
              </p>
            </div>
          </section>

          <section style={{ paddingTop: 12 }}>
            <div className="tiers">
              {TIERS.map((tier) => (
                <div
                  className={`tier${tier.featured ? " tier--featured" : ""}`}
                  key={tier.name}
                >
                  <span className="tier__name">{tier.name}</span>
                  <div className="tier__price">
                    {tier.price}
                    <small>{tier.per}</small>
                  </div>
                  <p className="tier__job">{tier.job}</p>
                  <ul className="tier__list">
                    {tier.features.map((f) => (
                      <li key={f}>{f}</li>
                    ))}
                  </ul>
                  <Link
                    href={tier.cta.href}
                    className={`btn btn--small ${tier.featured ? "btn--ink" : "btn--ghost"}`}
                    style={{ justifyContent: "center" }}
                  >
                    {tier.cta.label}
                  </Link>
                  <span className="tier__beta">Free during beta</span>
                </div>
              ))}
            </div>
          </section>

          <section className="frow">
            <div className="fnote">
              <strong>Why not per connector?</strong> Because every connector you add
              makes the map more complete and the verdicts more accurate. Charging for
              connectors would price you out of the thing that protects you. Retention
              comes from the gate: teams stop paying for gates only when they stop
              changing things, which is never.
            </div>
          </section>
        </div>

        <section className="cta">
          <div className="container">
            <div className="cta__panel">
              <h2>Start with the free map</h2>
              <p>
                Connect n8n, Airtable and Slack. The first look at your own labyrinth is
                usually enough.
              </p>
              <Link href="/signup" className="btn btn--paper">
                Get early access <span className="btn__arrow">→</span>
              </Link>
            </div>
          </div>
        </section>
      </main>
      <Footer />
    </>
  );
}

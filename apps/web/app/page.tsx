import Link from "next/link";
import { Footer } from "../components/footer";
import { HeroBackdrop, HeroGraph, ThreadLines } from "../components/hero-graph";
import {
  GlyphBranch,
  GlyphChat,
  GlyphDb,
  GlyphFlow,
  GlyphGrid,
} from "../components/marks";
import { Nav } from "../components/nav";
import { AgentRefusal, GiveUpTrace, HistorianTrace } from "../components/product-cards";

export default function Home() {
  return (
    <>
      <Nav />
      <main>
        {/* ------------------------------------------------------- hero */}
        <section className="hero">
          <div className="container">
            <div className="hero__panel">
              <HeroBackdrop />

              <span className="chip" style={{ top: "11%", left: "6%" }} aria-hidden="true">
                <GlyphFlow />
              </span>
              <span
                className="chip"
                style={{ top: "9%", right: "7%", animationDelay: "-2s" }}
                aria-hidden="true"
              >
                <GlyphGrid />
              </span>
              <span
                className="chip"
                style={{ top: "46%", left: "3.5%", animationDelay: "-4s" }}
                aria-hidden="true"
              >
                <GlyphChat />
              </span>
              <span
                className="chip"
                style={{ top: "42%", right: "3.5%", animationDelay: "-1s" }}
                aria-hidden="true"
              >
                <GlyphDb />
              </span>
              <span
                className="chip"
                style={{ top: "26%", right: "13%", animationDelay: "-5s" }}
                aria-hidden="true"
              >
                <GlyphBranch />
              </span>

              <div className="hero__head">
                <span className="hero__badge">
                  <span className="hero__badge-dot" />
                  Change intelligence for operations
                </span>
                <h1 className="hero__title">
                  See the blast radius <em>before</em> you break it
                </h1>
                <p className="hero__lede">
                  Ariadne keeps a living map of your automations, data and APIs,
                  remembers why every connection exists, and gates the changes
                  that would take revenue down with them.
                </p>
                <div className="hero__actions">
                  <Link href="/signup" className="btn btn--ink">
                    Get early access <span className="btn__arrow">→</span>
                  </Link>
                  <Link href="/product/blast-radius" className="btn btn--ghost">
                    See how it works
                  </Link>
                </div>
              </div>

              <HeroGraph />
            </div>
          </div>
        </section>

        {/* -------------------------------------------------- proof bar */}
        <section className="proofbar" aria-label="Product facts">
          <div className="container">
            <div className="proofbar__inner">
              <div className="proofbar__item">
                <div className="proofbar__value">~40ms</div>
                <div className="proofbar__label">
                  to a verdict. Pure graph math, no model in the path.
                </div>
              </div>
              <div className="proofbar__item">
                <div className="proofbar__value">11s</div>
                <div className="proofbar__label">
                  from a bad deletion to one click revert.
                </div>
              </div>
              <div className="proofbar__item">
                <div className="proofbar__value">3 modes</div>
                <div className="proofbar__label">
                  block on PRs, gate agents, revert GUI edits.
                </div>
              </div>
              <div className="proofbar__item">
                <div className="proofbar__value">0 guesses</div>
                <div className="proofbar__label">
                  coverage counts only human confirmed rationale.
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* ------------------------------------------------ how it works */}
        <section className="section" id="how-it-works">
          <div className="container">
            <div className="section__head section__head--center">
              <span className="eyebrow eyebrow--thread">How it works</span>
              <h2 className="section__title">Map. Explain. Gate.</h2>
              <p className="section__lede">
                Three moves, in order. The map makes the graph, the graph makes
                the rationale useful, and both together make the gate possible.
              </p>
            </div>

            <div className="steps">
              <div className="step">
                <span className="step__no">01 · Map</span>
                <h3 className="step__title">Crawl everything that runs</h3>
                <p className="step__body">
                  Cartographer reads your n8n flows, Airtable bases, Postgres
                  schemas and GitHub repos, and builds one dependency graph of
                  who reads what, who writes what, and what breaks what.
                </p>
                <div className="step__art">
                  <svg width="160" height="88" viewBox="0 0 160 88" aria-hidden="true">
                    <g stroke="var(--ink-faint)" strokeWidth="1.2" strokeDasharray="3 4" fill="none">
                      <path d="M30 24 L80 44 L30 64 M80 44 L130 24 M80 44 L130 64" />
                    </g>
                    <g fill="var(--card)" stroke="var(--ink)" strokeWidth="1.4">
                      <circle cx="30" cy="24" r="7" />
                      <circle cx="30" cy="64" r="7" />
                      <circle cx="130" cy="24" r="7" />
                      <circle cx="130" cy="64" r="7" />
                    </g>
                    <circle cx="80" cy="44" r="9" fill="var(--thread)" />
                  </svg>
                </div>
              </div>

              <div className="step">
                <span className="step__no">02 · Explain</span>
                <h3 className="step__title">Recover the why</h3>
                <p className="step__body">
                  Historian agents investigate every unexplained edge: they
                  search Slack, follow threads, check commits, and attach the
                  human reasoning behind each connection with a source link.
                </p>
                <div className="step__art" style={{ padding: 12 }}>
                  <blockquote className="rationale-quote" style={{ margin: 0, fontSize: 12 }}>
                    &ldquo;feeds EU VAT reporting, do not drop&rdquo;
                    <br />
                    <strong>@priya</strong> · #ops · Mar 2024
                  </blockquote>
                </div>
              </div>

              <div className="step">
                <span className="step__no">03 · Gate</span>
                <h3 className="step__title">Stand in the change path</h3>
                <p className="step__body">
                  Every proposed change gets a deterministic verdict with the
                  evidence attached: approve, warn, or block. What cannot be
                  blocked gets detected in seconds and reverted in one click.
                </p>
                <div className="step__art" style={{ padding: 12, placeItems: "stretch" }}>
                  <div
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      gap: 8,
                      justifyContent: "center",
                      alignItems: "flex-start",
                    }}
                  >
                    <span className="verdict-tag verdict-tag--approve">
                      <span className="verdict-tag__dot" /> approve · rename field
                    </span>
                    <span className="verdict-tag verdict-tag--warn">
                      <span className="verdict-tag__dot" /> warn · sole owner leaving
                    </span>
                    <span className="verdict-tag verdict-tag--block">
                      <span className="verdict-tag__dot" /> block · revenue path
                    </span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* ---------------------------------------------------- agents */}
        <section className="section">
          <div className="container">
            <div className="split">
              <div className="split__copy">
                <span className="eyebrow eyebrow--thread">Agents that investigate</span>
                <h2>Twelve investigations at once, none of them guessing</h2>
                <p>
                  When someone hands in notice, Ariadne finds every connection
                  only they can explain and fans out an agent per edge. Each one
                  searches, reads, follows leads, and decides for itself when it
                  actually knows the answer.
                </p>
                <ul className="split__points">
                  <li>
                    <span>
                      <strong>Real tool loops, visible traces.</strong> Every
                      step an agent takes is recorded and rendered, so the
                      reasoning path is a product surface, not a log file.
                    </span>
                  </li>
                  <li>
                    <span>
                      <strong>Allowed to give up.</strong> An agent that must
                      find an answer will invent one. Ours flag what they cannot
                      explain instead of confabulating.
                    </span>
                  </li>
                  <li>
                    <span>
                      <strong>Humans confirm, always.</strong> Drafts never
                      count toward coverage until a person approves them.
                    </span>
                  </li>
                </ul>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                <HistorianTrace />
                <GiveUpTrace />
              </div>
            </div>
          </div>
        </section>

        {/* -------------------------------------------------- the gate */}
        <section className="section">
          <div className="container">
            <div className="split split--flip">
              <AgentRefusal />
              <div className="split__copy">
                <span className="eyebrow eyebrow--thread">Built for the agentic era</span>
                <h2>Everyone ships agents that act. We ship the thing that tells them no.</h2>
                <p>
                  AI agents are the fastest growing source of unreviewed
                  production changes. Ariadne exposes its gate over MCP, so any
                  agent must ask before it mutates a connected system, and gets
                  refused with reasons when the blast radius says so.
                </p>
                <div>
                  <Link href="/product/gate" className="btn btn--ghost btn--small">
                    Three enforcement modes <span className="btn__arrow">→</span>
                  </Link>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* --------------------------------------------------- pillars */}
        <section className="section">
          <div className="container">
            <div className="section__head">
              <span className="eyebrow eyebrow--thread">The product</span>
              <h2 className="section__title">One graph, three jobs</h2>
            </div>
            <div className="pillars">
              <Link href="/product/blast-radius" className="pillar">
                <span className="eyebrow">Blast radius</span>
                <h3 className="pillar__title">Know what a change touches</h3>
                <p className="pillar__body">
                  Scored, decaying impact across every downstream flow, table
                  and report, with the rationale for each dependency attached.
                </p>
                <span className="pillar__link">Explore the graph →</span>
              </Link>
              <Link href="/product/agents" className="pillar">
                <span className="eyebrow">Knowledge capture</span>
                <h3 className="pillar__title">Keep the why when people leave</h3>
                <p className="pillar__body">
                  Investigation agents recover the reasoning behind every
                  connection from Slack, PRs and commits, before the person who
                  knows it resigns.
                </p>
                <span className="pillar__link">Meet the agents →</span>
              </Link>
              <Link href="/product/gate" className="pillar">
                <span className="eyebrow">Enforcement</span>
                <h3 className="pillar__title">Gate the change path</h3>
                <p className="pillar__body">
                  True blocks where a hook exists, eleven second reverts where
                  one does not, and an MCP gate every AI agent has to ask first.
                </p>
                <span className="pillar__link">See the gate →</span>
              </Link>
            </div>
          </div>
        </section>

        {/* ------------------------------------------------------- cta */}
        <section className="cta">
          <div className="container">
            <div className="cta__panel">
              <ThreadLines className="cta__thread" />
              <span className="eyebrow" style={{ color: "#9aa0ac" }}>
                Early access
              </span>
              <h2>CI got gates a decade ago. Your operations never did.</h2>
              <p>
                Connect n8n, Airtable and Slack, watch the map draw itself, and
                put a gate on the layer where your revenue actually runs.
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

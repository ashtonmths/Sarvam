"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { PageHead, VerdictBadge } from "../../../components/app/ui";
import { GlyphDb, GlyphFlow, GlyphGrid } from "../../../components/marks";
import { type SimulatedDecision, simulate } from "../../../lib/mock/verdict";

/**
 * Connect → crawl → first verdict, under ten minutes. The wait during crawl
 * is the demo — the map assembling is the first wow. Dismissible, never a
 * jail: every rail step is real navigation and abandoning it leaves a usable
 * app.
 */

const CONNECTOR_CHOICES = [
  {
    id: "n8n",
    label: "n8n",
    detail: "Read-only API key · workflows and executions",
    glyph: <GlyphFlow />,
  },
  {
    id: "postgres",
    label: "Postgres",
    detail: "Read-only role · schema and views, never rows",
    glyph: <GlyphDb />,
  },
  {
    id: "airtable",
    label: "Airtable",
    detail: "OAuth · base schema only, no cell payloads",
    glyph: <GlyphGrid />,
  },
];

const CRAWL_LINES = [
  "connected read-only · sadhak_ro",
  "tables: customers, invoices",
  "fields: vat_rate, amount, email …",
  "views: eu_vat_report",
  "n8n: billing-sync (3 steps)",
  "n8n: vat-report-mailer (3 steps)",
  "n8n: dunning-reminders (2 steps)",
  "airtable: Finance Ops / Invoices Mirror",
  "fusing cross-vendor edges…",
  "24 nodes · 22 edges mapped",
];

export default function OnboardingPage() {
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [picked, setPicked] = useState<string | null>(null);
  const [demoMode, setDemoMode] = useState(false);
  const [crawlLines, setCrawlLines] = useState<string[]>([]);
  const [decision, setDecision] = useState<SimulatedDecision | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(
    () => () => {
      if (timer.current) clearInterval(timer.current);
    },
    [],
  );

  function startCrawl() {
    setStep(2);
    setCrawlLines([]);
    let i = 0;
    timer.current = setInterval(() => {
      i += 1;
      setCrawlLines(CRAWL_LINES.slice(0, i));
      if (i >= CRAWL_LINES.length && timer.current) {
        clearInterval(timer.current);
        timer.current = null;
      }
    }, 600);
  }

  const crawlDone = crawlLines.length >= CRAWL_LINES.length;

  function runFirstVerdict() {
    setStep(3);
    // The wizard proposes the org's highest-criticality node with dependents.
    setDecision(simulate(3, "delete"));
  }

  const steps = [
    { n: 1, label: "Connect" },
    { n: 2, label: "Crawl" },
    { n: 3, label: "First verdict" },
  ] as const;

  return (
    <>
      <PageHead
        title="Onboarding"
        sub="Connect a system, watch the map assemble, and get a verdict about your own stack — with evidence you can click."
      >
        <Link href="/app" className="btn btn--ghost btn--small">
          Skip for now
        </Link>
      </PageHead>

      {/* An ordered list, because that is what the rail is: numbered steps in
          sequence. aria-current marks where the reader stands. */}
      <ol className="wizard__rail" aria-label="Onboarding progress">
        {steps.map((s, i) => (
          <li
            key={s.n}
            style={{ display: "inline-flex", alignItems: "center", gap: 10 }}
            aria-current={step === s.n ? "step" : undefined}
          >
            {i > 0 && <i className="wizard__dash" aria-hidden="true" />}
            <span
              className="wizard__step"
              data-state={step === s.n ? "active" : step > s.n ? "done" : "todo"}
              data-testid={`onboarding-step-${s.label.toLowerCase().replace(" ", "-")}`}
            >
              <span className="wizard__step-n">{step > s.n ? "✓" : s.n}</span>
              {s.label}
            </span>
          </li>
        ))}
      </ol>

      {step === 1 && (
        <div className="panel">
          <h2 className="panel__title">Pick a system to map</h2>
          <p className="panel__caption">
            Crawls are read-only and scoped to structure — the scopes are shown before we
            ask for anything.
          </p>
          <div className="connector-pick">
            {CONNECTOR_CHOICES.map((c) => (
              <button
                key={c.id}
                type="button"
                aria-pressed={picked === c.id}
                onClick={() => setPicked(c.id)}
                data-testid={`onboarding-pick-${c.id}`}
              >
                {c.glyph}
                <strong>{c.label}</strong>
                <span className="dim" style={{ fontSize: 12.5 }}>
                  {c.detail}
                </span>
              </button>
            ))}
          </div>
          <div
            style={{
              display: "flex",
              gap: 12,
              marginTop: 18,
              alignItems: "center",
              flexWrap: "wrap",
            }}
          >
            <button
              type="button"
              className="btn btn--ink"
              disabled={!picked}
              onClick={startCrawl}
              data-testid="onboarding-connect"
            >
              Connect &amp; crawl
            </button>
            <button
              type="button"
              className="btn btn--ghost"
              onClick={() => {
                setDemoMode(true);
                setPicked("postgres");
                startCrawl();
              }}
              data-testid="onboarding-demo"
            >
              No credentials handy? Explore a demo org
            </button>
          </div>
        </div>
      )}

      {step === 2 && (
        <div className="panel">
          {demoMode && (
            <div className="banner banner--info" role="status">
              Demo data — the demo_billing fixture. Deleted the moment you connect a real
              system.
            </div>
          )}
          <h2 className="panel__title">Crawling{picked ? ` ${picked}` : ""}…</h2>
          <p className="panel__caption">
            The map assembling is the product working — this wait is the demo.
          </p>
          <div className="crawl-progress">
            <div className="crawl-progress__bar">
              <div
                className="crawl-progress__fill"
                style={{
                  width: `${Math.round((crawlLines.length / CRAWL_LINES.length) * 100)}%`,
                }}
              />
            </div>
            <div aria-live="polite">
              {crawlLines.map((l, i) => (
                <div key={i}>{l}</div>
              ))}
            </div>
          </div>
          {crawlDone && (
            <div style={{ marginTop: 16, display: "flex", gap: 12, flexWrap: "wrap" }}>
              <button
                type="button"
                className="btn btn--ink"
                onClick={runFirstVerdict}
                data-testid="onboarding-first-verdict"
              >
                Run your first verdict
              </button>
              <Link href="/app/graph" className="btn btn--ghost">
                See the map first
              </Link>
            </div>
          )}
        </div>
      )}

      {step === 3 && decision && (
        <>
          <div className="banner banner--info" role="status">
            We picked your highest-criticality node with dependents:{" "}
            <code className="mono">invoices.vat_rate</code> — and simulated deleting it.
          </div>

          <div className="verdict-card" style={{ marginBottom: 18 }}>
            <div className="verdict-card__head">
              <VerdictBadge verdict={decision.result.verdict} big />
              <div>
                <strong style={{ fontSize: 16 }}>delete invoices.vat_rate</strong>
                <div className="dim" style={{ fontSize: 13 }}>
                  {decision.result.impacted.length} downstream nodes scored in{" "}
                  {decision.result.computedInMs}ms
                </div>
              </div>
            </div>
            <div className="verdict-card__body">
              <div className="evidence">
                {decision.result.evidence.map((ev, i) => (
                  <div key={i} className="evidence__row">
                    <Link
                      href="/app/graph"
                      style={{ fontWeight: 600, color: "var(--thread)" }}
                    >
                      {ev.name}
                    </Link>
                    <span className="evidence__rule">{ev.rule}</span>
                    <span className="evidence__impact">{ev.impact.toFixed(2)}</span>
                  </div>
                ))}
              </div>
            </div>
            <div className="explain">{decision.explanation}</div>
          </div>

          <div className="panel">
            <h2 className="panel__title">Make this real</h2>
            <p className="panel__caption">
              That verdict was a simulation. Enforcement puts the same engine in the
              change path.
            </p>
            <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
              <Link href="/app/settings/connectors" className="btn btn--ink btn--small">
                Install the GitHub check
              </Link>
              <Link href="/app/settings/api-keys" className="btn btn--ghost btn--small">
                Mint a gate API key
              </Link>
              <Link href="/app/graph" className="btn btn--ghost btn--small">
                Explore the graph
              </Link>
            </div>
          </div>
        </>
      )}
    </>
  );
}

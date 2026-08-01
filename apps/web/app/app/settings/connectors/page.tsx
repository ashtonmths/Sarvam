"use client";

import Link from "next/link";
import { useState } from "react";
import { EmptyState } from "../../../../components/app/ui";
import { GlyphBranch, GlyphDb, GlyphFlow, GlyphGrid } from "../../../../components/marks";
import { CONNECTORS } from "../../../../lib/mock/data";
import { useHasGraph } from "../../../../lib/queries";
import { useSession } from "../../../../lib/session";

const GLYPH: Record<string, React.ReactNode> = {
  postgres: <GlyphDb />,
  n8n: <GlyphFlow />,
  airtable: <GlyphGrid />,
  github: <GlyphBranch />,
};

export default function ConnectorsPane() {
  const { org } = useSession();
  const { hasGraph } = useHasGraph(org?.id ?? null);
  const [crawling, setCrawling] = useState<string | null>(null);

  if (!hasGraph) {
    return (
      <EmptyState
        title="No connectors yet"
        body="Everything downstream — the graph, verdicts, agents, metrics — starts with one read-only connection."
        action={{ href: "/app/onboarding", label: "Connect your first system →" }}
      />
    );
  }

  return (
    <>
      <section className="panel" style={{ marginBottom: 16 }}>
        <h2 className="panel__title">Connected systems</h2>
        <p className="panel__caption">
          Crawls are read-only; every requested scope is shown verbatim — where your
          security reviewer will look.
        </p>

        {CONNECTORS.map((c) => (
          <div key={c.id} className="conn-row" data-testid={`connector-${c.connector}`}>
            {GLYPH[c.connector]}
            <div className="conn-row__meta">
              <strong>{c.label}</strong>
              <span>
                {c.statusDetail} · {c.lastCrawlStats}
              </span>
              <ul className="scope-list">
                {c.scopes.map((s) => (
                  <li key={s}>{s}</li>
                ))}
              </ul>
            </div>
            <span
              className={`tag ${
                c.status === "healthy"
                  ? "tag--green"
                  : c.status === "warning"
                    ? "tag--amber"
                    : "tag--red"
              }`}
            >
              {c.status}
            </span>
            <button
              type="button"
              className="btn btn--ghost btn--tiny"
              disabled={crawling === c.id}
              onClick={() => {
                setCrawling(c.id);
                setTimeout(() => setCrawling(null), 2500);
              }}
              data-testid={`connector-crawl-${c.connector}`}
            >
              {crawling === c.id ? "Crawling…" : "Crawl now"}
            </button>
          </div>
        ))}

        <div style={{ marginTop: 14 }}>
          <Link href="/app/onboarding" className="btn btn--ink btn--small">
            Add a connector
          </Link>
        </div>
      </section>

      <section className="panel">
        <h2 className="panel__title">GitHub</h2>
        <p className="panel__caption">
          Hard gate — a Check that disables merge on BLOCK.
        </p>
        <div className="banner banner--warn" role="status">
          <strong>Installed but not enforcing.</strong> The check runs on
          acme-ops/automation, but branch protection doesn&rsquo;t require it — a BLOCK is
          currently advisory.{" "}
          <a
            href="https://github.com/acme-ops/automation/settings/branches"
            target="_blank"
            rel="noreferrer"
            style={{ textDecoration: "underline" }}
          >
            Require the check in branch protection ↗
          </a>
        </div>
      </section>
    </>
  );
}

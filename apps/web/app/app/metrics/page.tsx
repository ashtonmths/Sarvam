"use client";

import Link from "next/link";
import { EmptyState, PageHead } from "../../../components/app/ui";
import { METRICS } from "../../../lib/mock/data";
import { useHasGraph } from "../../../lib/queries";
import { useSession } from "../../../lib/session";

const DAYS = ["Wed", "Thu", "Fri", "Sat", "Sun", "Mon", "Tue"];

function Bars({ values, color }: { values: number[]; color: string }) {
  const max = Math.max(...values, 1);
  const w = 300;
  const h = 90;
  const bw = w / values.length - 6;
  return (
    <div className="chart">
      <svg
        viewBox={`0 0 ${w} ${h}`}
        role="img"
        aria-label={`Daily values: ${values.join(", ")}`}
      >
        {values.map((v, i) => {
          const bh = Math.max(2, (v / max) * (h - 18));
          return (
            <g key={i}>
              <rect
                x={i * (w / values.length) + 3}
                y={h - bh - 14}
                width={bw}
                height={bh}
                rx={3}
                fill={color}
                opacity={i === values.length - 1 ? 1 : 0.55}
              />
              <text
                x={i * (w / values.length) + 3 + bw / 2}
                y={h - 3}
                textAnchor="middle"
                fontSize={8}
                fill="var(--ink-faint)"
                fontFamily="var(--font-mono)"
              >
                {DAYS[i]}
              </text>
            </g>
          );
        })}
      </svg>
      <details>
        <summary>table</summary>
        <table className="dtable">
          <thead>
            <tr>
              {DAYS.map((d) => (
                <th key={d}>{d}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            <tr>
              {values.map((v, i) => (
                <td key={i} className="mono">
                  {v}
                </td>
              ))}
            </tr>
          </tbody>
        </table>
      </details>
    </div>
  );
}

function DistRows() {
  const dist = METRICS.detectRevertDist;
  const max = Math.max(...dist.flatMap((d) => [d.detect, d.revert]), 1);
  return (
    <div className="chart" style={{ marginTop: 10 }}>
      <p className="mono dim" style={{ fontSize: 10.5, marginBottom: 6 }}>
        distributions · n={METRICS.revertsExecuted} — small numbers, shown honestly
      </p>
      <svg
        viewBox="0 0 300 76"
        role="img"
        aria-label="Time-to-detect and time-to-revert distributions by bucket"
      >
        {dist.map((d, i) => {
          const x = i * 75;
          return (
            <g key={d.bucket}>
              <rect
                x={x + 8}
                y={54 - (d.detect / max) * 40}
                width={22}
                height={(d.detect / max) * 40}
                rx={3}
                fill="var(--thread)"
                opacity={0.85}
              />
              <rect
                x={x + 34}
                y={54 - (d.revert / max) * 40}
                width={22}
                height={(d.revert / max) * 40}
                rx={3}
                fill="var(--block)"
                opacity={0.6}
              />
              <text
                x={x + 32}
                y={66}
                textAnchor="middle"
                fontSize={8}
                fill="var(--ink-faint)"
                fontFamily="var(--font-mono)"
              >
                {d.bucket}
              </text>
            </g>
          );
        })}
        <rect x={182} y={70} width={8} height={5} fill="var(--thread)" opacity={0.85} />
        <text
          x={194}
          y={75}
          fontSize={7.5}
          fill="var(--ink-faint)"
          fontFamily="var(--font-mono)"
        >
          detect
        </text>
        <rect x={232} y={70} width={8} height={5} fill="var(--block)" opacity={0.6} />
        <text
          x={244}
          y={75}
          fontSize={7.5}
          fill="var(--ink-faint)"
          fontFamily="var(--font-mono)"
        >
          revert
        </text>
      </svg>
      <details>
        <summary>table</summary>
        <table className="dtable">
          <thead>
            <tr>
              <th>Bucket</th>
              <th>Detect</th>
              <th>Revert</th>
            </tr>
          </thead>
          <tbody>
            {dist.map((d) => (
              <tr key={d.bucket}>
                <td className="mono">{d.bucket}</td>
                <td className="mono">{d.detect}</td>
                <td className="mono">{d.revert}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </div>
  );
}

function CoverageBars() {
  const { confirmedCount, draftCount, edgeCount } = METRICS;
  const w = 300;
  return (
    <div className="chart">
      <svg
        viewBox={`0 0 ${w} 74`}
        role="img"
        aria-label={`Confirmed ${confirmedCount} edges, drafts pending ${draftCount}, of ${edgeCount} edges total`}
      >
        <text
          x={0}
          y={12}
          fontSize={9}
          fill="var(--ink-soft)"
          fontFamily="var(--font-mono)"
        >
          confirmed · counts toward coverage
        </text>
        <rect
          x={0}
          y={18}
          width={(confirmedCount / edgeCount) * w}
          height={14}
          rx={4}
          fill="var(--approve)"
        />
        <text
          x={(confirmedCount / edgeCount) * w + 6}
          y={29}
          fontSize={10}
          fill="var(--ink)"
          fontFamily="var(--font-mono)"
        >
          {confirmedCount}
        </text>
        <text
          x={0}
          y={52}
          fontSize={9}
          fill="var(--ink-soft)"
          fontFamily="var(--font-mono)"
        >
          drafts pending · never counted
        </text>
        <rect
          x={0}
          y={58}
          width={(draftCount / edgeCount) * w}
          height={14}
          rx={4}
          fill="var(--warn)"
          opacity={0.7}
        />
        <text
          x={(draftCount / edgeCount) * w + 6}
          y={69}
          fontSize={10}
          fill="var(--ink)"
          fontFamily="var(--font-mono)"
        >
          {draftCount}
        </text>
      </svg>
      <details>
        <summary>table</summary>
        <table className="dtable">
          <tbody>
            <tr>
              <td>Confirmed</td>
              <td className="mono">{confirmedCount}</td>
            </tr>
            <tr>
              <td>Drafts pending</td>
              <td className="mono">{draftCount}</td>
            </tr>
            <tr>
              <td>Edges total</td>
              <td className="mono">{edgeCount}</td>
            </tr>
          </tbody>
        </table>
      </details>
    </div>
  );
}

export default function MetricsPage() {
  const { org } = useSession();
  const { hasGraph } = useHasGraph(org?.id ?? null);
  const m = METRICS;

  if (!hasGraph) {
    return (
      <>
        <PageHead
          title="Metrics"
          sub="Observable facts lead; anything modelled is labeled as modelled."
        />
        <EmptyState
          title="Nothing to count yet"
          body="These panels populate as the gate decides, Reflex reverts, and reviewers confirm rationale. A zero here would look like failure — it isn't; it's a young org."
          action={{ href: "/app/onboarding", label: "Connect a system →" }}
        />
      </>
    );
  }

  return (
    <>
      <PageHead
        title="Metrics"
        sub="Observable facts lead; anything modelled is labeled as modelled. No panel claims prevention for Reflex, and coverage is never summed into one number."
      />

      <div className="panel-grid panel-grid--3" style={{ marginBottom: 16 }}>
        <section className="panel">
          <h2 className="panel__title">Changes gated · 7 days</h2>
          <p className="panel__caption">
            Enforced modes only. Dry-run simulations are excluded.
          </p>
          <div style={{ display: "flex", gap: 10, marginBottom: 12 }}>
            <span className="vbadge vbadge--block">{m.blocked} blocked</span>
            <span className="vbadge vbadge--warn">{m.warned} warned</span>
            <span className="vbadge vbadge--approve">{m.approved} approved</span>
          </div>
          <Bars values={m.weeklyVerdicts} color="var(--thread)" />
        </section>

        <section className="panel">
          <h2 className="panel__title">Reverts executed</h2>
          <p className="panel__caption">
            Labeled time-to-detect and time-to-revert — never &ldquo;incidents
            prevented.&rdquo;
          </p>
          <div className="stat" style={{ marginBottom: 10 }}>
            <span className="stat__value">{m.revertsExecuted}</span>
            <span className="stat__hint">
              time to detect p50 {(m.mttdP50Ms / 1000).toFixed(1)}s · time to revert p50{" "}
              {(m.mttrP50Ms / 1000).toFixed(1)}s
            </span>
          </div>
          <Bars values={m.weeklyReverts} color="var(--block)" />
          <DistRows />
        </section>

        <section className="panel">
          <h2 className="panel__title">Coverage</h2>
          <p className="panel__caption">
            Confirmed rationale only. Drafts shown separately and never counted.
          </p>
          <div className="stat" style={{ marginBottom: 10 }}>
            <span className="stat__value">{m.coverageConfirmedPct}%</span>
            <span className="stat__hint">
              {m.confirmedCount} of {m.edgeCount} edges confirmed · {m.draftCount} drafts
              pending
            </span>
          </div>
          <CoverageBars />
        </section>
      </div>

      <div className="panel-grid panel-grid--2">
        <section className="panel">
          <h2 className="panel__title">Knowledge concentration</h2>
          <p className="panel__caption">
            Banded estimate with its confidence inside the claim — no naive bus-factor
            count is computed or displayed.
          </p>
          <p style={{ fontSize: 15 }}>
            <strong>{m.atRiskNodes} nodes</strong> {m.atRiskBand} — {m.atRiskConfidence}.
          </p>
          <p style={{ fontSize: 14, color: "var(--ink-soft)", marginTop: 8 }}>
            The person behind them: {m.atRiskPeople.join(", ")} (departed March 2026).{" "}
            <Link
              href="/app/agents/departure"
              style={{ color: "var(--thread)", textDecoration: "underline" }}
            >
              Remediation is one click: run the exit interview →
            </Link>
          </p>
        </section>

        <section className="panel">
          <h2 className="panel__title">Backtest</h2>
          <p className="panel__caption">
            Reproducibility next to the number: run id and input hash printed on the
            panel.
          </p>
          <div className="stat">
            <span className="stat__value">{Math.round(m.backtestHitRate * 100)}%</span>
            <span className="stat__hint">
              hit rate on this org&rsquo;s change history · would-have-blocked changes
              later confirmed breaking
            </span>
          </div>
          <p className="mono dim" style={{ fontSize: 11.5, marginTop: 10 }}>
            {m.backtestRunId} · {m.backtestInputHash}
          </p>
        </section>
      </div>
    </>
  );
}

import Link from "next/link";
import type { Provenance } from "../../lib/mock/data";

export function VerdictBadge({
  verdict,
  big,
}: {
  verdict: "APPROVE" | "WARN" | "BLOCK";
  big?: boolean;
}) {
  return (
    <span
      className={`vbadge vbadge--${verdict.toLowerCase()}${big ? " vbadge--big" : ""}`}
      data-testid="verdict-badge"
    >
      {verdict}
    </span>
  );
}

export function ProvenanceTag({
  provenance,
  confidence,
}: {
  provenance: Provenance;
  confidence: number;
}) {
  const label = {
    static_parse: "static",
    runtime_observed: "runtime",
    llm_inferred: "llm-inferred",
  }[provenance];
  return (
    <span className={`tag${provenance === "llm_inferred" ? " tag--ghost" : ""}`}>
      {label} · {confidence.toFixed(2)}
    </span>
  );
}

export function PageHead({
  title,
  sub,
  children,
}: {
  title: string;
  sub?: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <div className="shell__head">
      <div>
        <h1>{title}</h1>
        {sub && <p className="shell__head-sub">{sub}</p>}
      </div>
      {children}
    </div>
  );
}

export function EmptyState({
  title,
  body,
  action,
}: {
  title: string;
  body: React.ReactNode;
  action?: { href: string; label: string };
}) {
  return (
    <div className="empty">
      <strong>{title}</strong>
      <p>{body}</p>
      {action && (
        <p style={{ marginTop: 10 }}>
          <Link href={action.href}>{action.label}</Link>
        </p>
      )}
    </div>
  );
}

export function Stat({
  label,
  value,
  hint,
}: {
  label: string;
  value: React.ReactNode;
  hint?: React.ReactNode;
}) {
  return (
    <div className="panel stat">
      <span className="stat__label">{label}</span>
      <span className="stat__value">{value}</span>
      {hint && <span className="stat__hint">{hint}</span>}
    </div>
  );
}

export function Kbd({ children }: { children: React.ReactNode }) {
  return <kbd className="kbd">{children}</kbd>;
}

"use client";

import { useState } from "react";
import type { Page } from "../../../../lib/api";
import { useQuery } from "../../../../lib/queries";
import { useSession } from "../../../../lib/session";

interface AuditRow {
  id: number;
  actorType: string;
  actorId: string;
  action: string;
  targetKind: string | null;
  targetId: string | null;
  ip: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export default function OrganizationPane() {
  const { org } = useSession();
  const audit = useQuery<Page<AuditRow>>("/api/audit?limit=100");
  const [filter, setFilter] = useState("");

  const rows = (audit.data?.items ?? []).filter(
    (row) =>
      !filter ||
      row.actorId.toLowerCase().includes(filter.toLowerCase()) ||
      row.action.toLowerCase().includes(filter.toLowerCase()),
  );

  return (
    <>
      <section className="panel" style={{ marginBottom: 16 }}>
        <h2 className="panel__title">Organization</h2>
        <table className="dtable">
          <tbody>
            <tr>
              <td>Name</td>
              <td>{org?.name ?? "—"}</td>
            </tr>
            <tr>
              <td>Slug</td>
              <td className="mono">{org?.slug ?? "—"}</td>
            </tr>
          </tbody>
        </table>
      </section>

      <section className="panel">
        <h2 className="panel__title">Audit log</h2>
        <p className="panel__caption">
          Append-only. Every privileged action lands here with a name on it — which is
          what makes &ldquo;why did you block my change?&rdquo; answerable months later.
        </p>
        <div className="filters">
          <input
            type="search"
            placeholder="Filter by actor or action…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            aria-label="Filter audit log"
            data-testid="audit-filter"
          />
        </div>
        {audit.loading ? (
          <div style={{ height: 120, opacity: 0.4 }} />
        ) : (
          <table className="dtable">
            <thead>
              <tr>
                <th>When</th>
                <th>Actor</th>
                <th>Action</th>
                <th>Target</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  <td className="dim" style={{ whiteSpace: "nowrap" }}>
                    {new Date(row.createdAt).toLocaleString()}
                  </td>
                  <td className="mono" style={{ fontSize: 12 }}>
                    {row.actorId}
                  </td>
                  <td className="mono" style={{ fontSize: 12, color: "var(--thread)" }}>
                    {row.action}
                  </td>
                  <td className="dim" style={{ fontSize: 12.5 }}>
                    {row.targetKind ? `${row.targetKind} #${row.targetId}` : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {rows.length === 0 && !audit.loading && (
          <p className="dim" style={{ fontSize: 13.5, padding: "14px 0" }}>
            Nothing matches that filter.
          </p>
        )}
      </section>
    </>
  );
}

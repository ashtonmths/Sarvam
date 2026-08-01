"use client";

import { useState } from "react";
import { api, type Page } from "../../../../lib/api";
import { API_URL } from "../../../../lib/env";
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

/**
 * Export and erasure, the two things a privacy policy is only allowed to
 * promise if they exist. Owner-only, and the delete asks for the org name
 * rather than a second confirm button — this is the one action in the product
 * that cannot be undone.
 */
function DataControls({ orgName }: { orgName: string }) {
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const armed = confirm === orgName;

  async function destroy() {
    setBusy(true);
    setError(null);
    try {
      await api.delete("/api/org", { confirmName: confirm });
      // Everything this session could read is gone, including the session's
      // own org. A hard reload is the honest response.
      window.location.href = "/";
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Deletion failed.");
      setBusy(false);
    }
  }

  return (
    <section className="panel danger">
      <h2 className="panel__title">Your data</h2>
      <p className="panel__caption">
        Take it with you, or take it away. Neither needs a support ticket.
      </p>

      <div className="danger__row">
        <div>
          <strong>Export everything</strong>
          <p className="dim" style={{ fontSize: 13, margin: "4px 0 0" }}>
            One JSON file: graph, rationale, verdicts, decisions and the audit log.
            Credentials are excluded — they are sealed to this organization and would not
            work anywhere else.
          </p>
        </div>
        <a
          className="btn btn--ghost"
          href={`${API_URL}/api/org/export`}
          data-testid="export-org"
        >
          Download
        </a>
      </div>

      <div className="danger__row danger__row--last">
        <div>
          <strong>Delete this organization</strong>
          <p className="dim" style={{ fontSize: 13, margin: "4px 0 0" }}>
            Removes the graph, every rationale, every verdict, all credentials and the
            audit log. It cascades at the database and there is no grace period, so we
            cannot bring it back for you afterwards.
          </p>
          <label className="danger__confirm">
            <span>
              Type <code>{orgName}</code> to confirm
            </span>
            <input
              type="text"
              value={confirm}
              onChange={(event) => setConfirm(event.target.value)}
              placeholder={orgName}
              aria-label="Organization name confirmation"
              data-testid="delete-confirm"
            />
          </label>
          {error && <p className="danger__error">{error}</p>}
        </div>
        <button
          type="button"
          className="btn btn--danger"
          disabled={!armed || busy}
          onClick={destroy}
          data-testid="delete-org"
        >
          {busy ? "Deleting…" : "Delete forever"}
        </button>
      </div>
    </section>
  );
}

export default function OrganizationPane() {
  const { org, capabilities } = useSession();
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
      <section className="panel">
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

      {/* Hidden rather than disabled for anyone who cannot use it: the API is
          the enforcement point, and showing an owner-only control to a viewer
          only invites them to click it. */}
      {capabilities.includes("org:delete") && org && <DataControls orgName={org.name} />}
    </>
  );
}

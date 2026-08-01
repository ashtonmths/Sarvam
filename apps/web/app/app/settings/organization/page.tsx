"use client";

import { useState } from "react";
import { AUDIT_LOG, fmtDate } from "../../../../lib/mock/data";
import { useSession } from "../../../../lib/session";

export default function OrganizationPane() {
  const { org } = useSession();
  const orgName = org?.name ?? "your organization";
  const orgSlug = org?.slug ?? "";
  const [filter, setFilter] = useState("");
  const [confirmText, setConfirmText] = useState("");

  const rows = AUDIT_LOG.filter(
    (r) =>
      !filter ||
      r.actor.toLowerCase().includes(filter.toLowerCase()) ||
      r.action.toLowerCase().includes(filter.toLowerCase()) ||
      r.detail.toLowerCase().includes(filter.toLowerCase()),
  );

  return (
    <>
      <section className="panel" style={{ marginBottom: 16 }}>
        <h2 className="panel__title">Organization</h2>
        <form
          style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "flex-end" }}
          onSubmit={(e) => e.preventDefault()}
        >
          <div className="field-inline">
            <label htmlFor="org-name">Name</label>
            <input id="org-name" type="text" defaultValue={orgName} />
          </div>
          <div className="field-inline">
            <label htmlFor="org-slug">Slug</label>
            <input id="org-slug" type="text" defaultValue={orgSlug} />
          </div>
          <button type="submit" className="btn btn--ink btn--small">
            Save
          </button>
        </form>
      </section>

      <section className="panel" style={{ marginBottom: 16 }}>
        <h2 className="panel__title">Audit log</h2>
        <p className="panel__caption">
          Every mutation, newest first. This viewer is itself read-only.
        </p>
        <div className="filters">
          <input
            type="search"
            placeholder="Filter by actor, action or detail…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            aria-label="Filter audit log"
            data-testid="audit-filter"
          />
        </div>
        <table className="dtable">
          <thead>
            <tr>
              <th>When</th>
              <th>Actor</th>
              <th>Action</th>
              <th>Detail</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td className="dim" style={{ whiteSpace: "nowrap" }}>
                  {fmtDate(r.at)}
                </td>
                <td className="mono" style={{ fontSize: 12 }}>
                  {r.actor}
                </td>
                <td className="mono" style={{ fontSize: 12, color: "var(--thread)" }}>
                  {r.action}
                </td>
                <td style={{ fontSize: 13.5 }}>{r.detail}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {rows.length === 0 && (
          <p className="dim" style={{ fontSize: 13.5, padding: "14px 0" }}>
            Nothing matches that filter.
          </p>
        )}
      </section>

      <section className="danger-zone">
        <h2 className="panel__title">Danger zone</h2>
        <div style={{ display: "flex", flexDirection: "column", gap: 14, marginTop: 10 }}>
          <div>
            <strong style={{ fontSize: 14 }}>Transfer ownership</strong>
            <p style={{ fontSize: 13, color: "var(--ink-soft)" }}>
              Hand the org to another member. You become an admin.
            </p>
            <button
              type="button"
              className="btn btn--ghost btn--tiny"
              style={{ marginTop: 6 }}
            >
              Transfer…
            </button>
          </div>
          <div>
            <strong style={{ fontSize: 14 }}>Delete organization</strong>
            <p style={{ fontSize: 13, color: "var(--ink-soft)", marginBottom: 8 }}>
              Type <code className="mono">{orgSlug}</code> to confirm. Deletes the graph,
              rationale, decisions and audit log.
            </p>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <input
                type="text"
                value={confirmText}
                onChange={(e) => setConfirmText(e.target.value)}
                placeholder={orgSlug}
                aria-label="Type the org slug to confirm deletion"
                style={{
                  border: "1px solid var(--line)",
                  borderRadius: 8,
                  padding: "7px 10px",
                  font: "inherit",
                  fontSize: 13,
                }}
              />
              <button
                type="button"
                className="btn btn--danger-ghost btn--tiny"
                disabled={confirmText !== orgSlug}
                onClick={() =>
                  window.alert("Mock: deletion is wired when the real API lands.")
                }
                data-testid="org-delete"
              >
                Delete {orgName}
              </button>
            </div>
          </div>
        </div>
      </section>
    </>
  );
}

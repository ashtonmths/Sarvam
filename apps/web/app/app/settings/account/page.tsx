"use client";

import { useState } from "react";
import { SESSIONS, timeAgo } from "../../../../lib/mock/data";
import { useSession } from "../../../../lib/session";

export default function AccountPane() {
  const { user } = useSession();
  const [revoked, setRevoked] = useState<Set<string>>(new Set());
  const [saved, setSaved] = useState(false);

  if (!user) return null;

  return (
    <>
      <section className="panel" style={{ marginBottom: 16 }}>
        <h2 className="panel__title">Profile</h2>
        <form
          style={{ display: "flex", flexDirection: "column", gap: 12, maxWidth: 380 }}
          onSubmit={(e) => {
            e.preventDefault();
            setSaved(true);
          }}
        >
          <div className="field-inline">
            <label htmlFor="acc-name">Name</label>
            <input id="acc-name" type="text" defaultValue={user.name} />
          </div>
          <div className="field-inline">
            <label htmlFor="acc-email">Email</label>
            <input id="acc-email" type="email" defaultValue={user.email} disabled />
          </div>
          <div className="field-inline">
            <label htmlFor="acc-pw">New password</label>
            <input id="acc-pw" type="password" placeholder="At least 12 characters" />
          </div>
          <div>
            <button type="submit" className="btn btn--ink btn--small">
              Save changes
            </button>
          </div>
          {saved && (
            <p className="dim" style={{ fontSize: 13 }} role="status">
              Mock: saved locally — persists with the real API.
            </p>
          )}
        </form>
      </section>

      <section className="panel" style={{ marginBottom: 16 }}>
        <h2 className="panel__title">Active sessions</h2>
        <p className="panel__caption">
          Device and IP are stored for exactly this — revoke anything you don&rsquo;t
          recognize.
        </p>
        <table className="dtable">
          <thead>
            <tr>
              <th>Device</th>
              <th>IP</th>
              <th>Last seen</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {SESSIONS.filter((s) => !revoked.has(s.id)).map((s) => (
              <tr key={s.id}>
                <td>
                  {s.device}
                  {s.current && (
                    <>
                      {" "}
                      <span className="tag tag--thread">current</span>
                    </>
                  )}
                </td>
                <td className="mono dim">{s.ip}</td>
                <td className="dim">
                  {s.lastSeen === "now" ? "now" : timeAgo(s.lastSeen)}
                </td>
                <td>
                  {!s.current && (
                    <button
                      type="button"
                      className="btn btn--danger-ghost btn--tiny"
                      onClick={() => setRevoked((r) => new Set(r).add(s.id))}
                      data-testid={`session-revoke-${s.id}`}
                    >
                      Revoke
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="danger-zone">
        <h2 className="panel__title">Delete account</h2>
        <p style={{ fontSize: 13.5, color: "var(--ink-soft)", marginBottom: 12 }}>
          You are the sole owner of Acme Operations. Transfer ownership first — the API
          refuses to orphan an org, and this button renders that refusal verbatim.
        </p>
        <button
          type="button"
          className="btn btn--danger-ghost btn--small"
          onClick={() =>
            window.alert(
              "Cannot delete: you are the sole owner of Acme Operations. Transfer ownership first.",
            )
          }
        >
          Delete my account
        </button>
      </section>
    </>
  );
}

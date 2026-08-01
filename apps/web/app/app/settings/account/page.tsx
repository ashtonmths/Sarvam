"use client";

import { api } from "../../../../lib/api";
import { useQuery } from "../../../../lib/queries";
import { useSession } from "../../../../lib/session";

interface SessionRow {
  id: number;
  userAgent: string | null;
  ip: string | null;
  lastSeenAt: string;
  createdAt: string;
}

export default function AccountPane() {
  const { user, org, capabilities } = useSession();
  const sessions = useQuery<{ items: SessionRow[] }>("/api/sessions");

  async function revoke(id: number) {
    await api.delete(`/api/sessions/${id}`).catch(() => undefined);
    sessions.reload();
  }

  if (!user) return null;

  return (
    <>
      <section className="panel">
        <h2 className="panel__title">Profile</h2>
        <table className="dtable">
          <tbody>
            <tr>
              <td>Name</td>
              <td>{user.name}</td>
            </tr>
            <tr>
              <td>Email</td>
              <td className="mono">{user.email}</td>
            </tr>
            <tr>
              <td>Role in {org?.name}</td>
              <td>
                <span className="tag tag--thread">{org?.role ?? user.role}</span>
              </td>
            </tr>
          </tbody>
        </table>
      </section>

      <section className="panel">
        <h2 className="panel__title">What you can do here</h2>
        <p className="panel__caption">
          Capabilities, not screens. Every route checks one of these; hiding a button in
          the UI is a convenience, never the enforcement.
        </p>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {capabilities.map((capability) => (
            <span key={capability} className="tag mono" style={{ fontSize: 11.5 }}>
              {capability}
            </span>
          ))}
        </div>
      </section>

      <section className="panel">
        <h2 className="panel__title">Active sessions</h2>
        <p className="panel__caption">
          Device and IP are recorded for exactly this — revoke anything you do not
          recognize.
        </p>
        {sessions.loading ? (
          <div style={{ height: 60, opacity: 0.4 }} />
        ) : (
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
              {(sessions.data?.items ?? []).map((session) => (
                <tr key={session.id}>
                  <td style={{ overflowWrap: "anywhere", maxWidth: 320 }}>
                    {session.userAgent ?? "unknown device"}
                  </td>
                  <td className="mono dim">{session.ip ?? "—"}</td>
                  <td className="dim">{new Date(session.lastSeenAt).toLocaleString()}</td>
                  <td>
                    <button
                      type="button"
                      className="btn btn--danger-ghost btn--tiny"
                      onClick={() => void revoke(session.id)}
                      data-testid={`session-revoke-${session.id}`}
                    >
                      Revoke
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </>
  );
}

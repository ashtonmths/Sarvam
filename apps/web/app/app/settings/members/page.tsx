"use client";

import { useState } from "react";
import { MEMBERS, PENDING_INVITES, timeAgo } from "../../../../lib/mock/data";

export default function MembersPane() {
  const [invited, setInvited] = useState(false);

  return (
    <>
      <section className="panel" style={{ marginBottom: 16 }}>
        <h2 className="panel__title">Members</h2>
        <p className="panel__caption">
          Role changes are constrained by policy — admins cannot touch owners. The UI
          encodes it; the API enforces it.
        </p>
        <table className="dtable">
          <thead>
            <tr>
              <th>Member</th>
              <th>Role</th>
              <th>Joined</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {MEMBERS.map((m) => (
              <tr key={m.id}>
                <td>
                  <strong>{m.name}</strong>
                  <div className="dim" style={{ fontSize: 12.5 }}>
                    {m.email}
                  </div>
                </td>
                <td>
                  {m.role === "owner" ? (
                    <span className="tag tag--thread">owner</span>
                  ) : (
                    <select
                      defaultValue={m.role}
                      aria-label={`Role for ${m.name}`}
                      style={{
                        border: "1px solid var(--line)",
                        borderRadius: 8,
                        padding: "5px 8px",
                        font: "inherit",
                        fontSize: 13,
                      }}
                    >
                      <option value="admin">admin</option>
                      <option value="member">member</option>
                      <option value="viewer">viewer</option>
                    </select>
                  )}
                </td>
                <td className="dim">{timeAgo(m.joinedAt)}</td>
                <td>
                  {m.role !== "owner" && (
                    <button type="button" className="btn btn--danger-ghost btn--tiny">
                      Remove
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="panel" style={{ marginBottom: 16 }}>
        <h2 className="panel__title">Invite</h2>
        <p className="panel__caption">Invitations expire after 7 days.</p>
        <form
          style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end" }}
          onSubmit={(e) => {
            e.preventDefault();
            setInvited(true);
          }}
        >
          <div className="field-inline">
            <label htmlFor="inv-email">Email</label>
            <input
              id="inv-email"
              type="email"
              required
              placeholder="teammate@company.com"
            />
          </div>
          <div className="field-inline">
            <label htmlFor="inv-role">Role</label>
            <select id="inv-role" defaultValue="member">
              <option value="admin">admin</option>
              <option value="member">member</option>
              <option value="viewer">viewer</option>
            </select>
          </div>
          <button
            type="submit"
            className="btn btn--ink btn--small"
            data-testid="members-invite"
          >
            Send invite
          </button>
        </form>
        {invited && (
          <p className="dim" style={{ fontSize: 13, marginTop: 10 }} role="status">
            Mock: invite recorded locally — email delivery arrives with the real API.
          </p>
        )}
      </section>

      <section className="panel">
        <h2 className="panel__title">Pending invitations</h2>
        <table className="dtable">
          <thead>
            <tr>
              <th>Email</th>
              <th>Role</th>
              <th>Expires</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {PENDING_INVITES.map((i) => (
              <tr key={i.id}>
                <td>{i.email}</td>
                <td className="mono dim">{i.role}</td>
                <td className="dim">{timeAgo(i.expiresAt).replace(" ago", "")}</td>
                <td>
                  <button type="button" className="btn btn--danger-ghost btn--tiny">
                    Revoke
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </>
  );
}

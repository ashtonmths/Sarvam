"use client";

import { useState } from "react";
import { Select } from "../../../../components/app/select";
import { ApiError, api } from "../../../../lib/api";
import { useQuery } from "../../../../lib/queries";

interface MemberRow {
  id: number;
  userId: number;
  name: string;
  email: string;
  role: "owner" | "admin" | "member" | "viewer";
  joinedAt: string;
}

const ROLES = [
  { value: "admin", label: "admin" },
  { value: "member", label: "member" },
  { value: "viewer", label: "viewer" },
];

function timeAgo(iso: string): string {
  const days = Math.round((Date.now() - new Date(iso).getTime()) / 86_400_000);
  if (days < 1) return "today";
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

export default function MembersPane() {
  const members = useQuery<{ items: MemberRow[] }>("/api/members");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("member");
  const [invite, setInvite] = useState<{ token: string; email: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function sendInvite() {
    setError(null);
    try {
      const res = await api.post<{ inviteToken: string }>("/api/members/invite", {
        email,
        role,
      });
      setInvite({ token: res.inviteToken, email });
      setEmail("");
    } catch (err) {
      setError(err instanceof ApiError ? err.userMessage : "Could not send the invite");
    }
  }

  async function changeRole(memberId: number, next: string) {
    try {
      await api.patch(`/api/members/${memberId}`, { role: next });
      members.reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.userMessage : "Could not change the role");
    }
  }

  async function remove(memberId: number, name: string) {
    if (!window.confirm(`Remove ${name} from this organization?`)) return;
    try {
      await api.delete(`/api/members/${memberId}`);
      members.reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.userMessage : "Could not remove the member");
    }
  }

  const items = members.data?.items ?? [];

  return (
    <>
      {error && (
        <div className="banner banner--warn" role="alert">
          {error}
        </div>
      )}

      <section className="panel">
        <h2 className="panel__title">Members</h2>
        <p className="panel__caption">
          Roles map to capabilities, not to screens. Admins cannot change an owner&rsquo;s
          role — the UI hides it and the API refuses it.
        </p>
        {members.loading ? (
          <div style={{ height: 80, opacity: 0.4 }} />
        ) : (
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
              {items.map((m) => (
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
                      <Select
                        value={m.role}
                        onChange={(next) => void changeRole(m.id, next)}
                        label={`Role for ${m.name}`}
                        options={ROLES}
                        small
                      />
                    )}
                  </td>
                  <td className="dim">{timeAgo(m.joinedAt)}</td>
                  <td>
                    {m.role !== "owner" && (
                      <button
                        type="button"
                        className="btn btn--danger-ghost btn--tiny"
                        onClick={() => void remove(m.id, m.name)}
                      >
                        Remove
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="panel">
        <h2 className="panel__title">Invite</h2>
        <p className="panel__caption">Invitations expire after 7 days.</p>
        <div
          style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end" }}
        >
          <div className="field-inline">
            <label htmlFor="inv-email">Email</label>
            <input
              id="inv-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="teammate@company.com"
            />
          </div>
          <Select value={role} onChange={setRole} label="Role" options={ROLES} />
          <button
            type="button"
            className="btn btn--ink btn--small"
            disabled={!email.trim()}
            onClick={() => void sendInvite()}
            data-testid="members-invite"
          >
            Create invite
          </button>
        </div>

        {invite && (
          <div className="banner banner--info" style={{ marginTop: 14 }} role="status">
            {/* No mailer is configured on this deployment, so the link is
                handed back rather than silently dropped. */}
            Invite created for <strong>{invite.email}</strong>. No email provider is
            configured, so send them this token yourself:{" "}
            <code className="mono">{invite.token}</code>
          </div>
        )}
      </section>
    </>
  );
}

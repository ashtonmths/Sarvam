"use client";

import { useState } from "react";
import { McpConnect } from "../../../../components/app/mcp-connect";
import { EmptyState } from "../../../../components/app/ui";
import { ApiError, api } from "../../../../lib/api";
import { useQuery } from "../../../../lib/queries";
import { useSession } from "../../../../lib/session";

interface ApiKeyRow {
  id: number;
  name: string;
  prefix: string;
  scopes: string[];
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

const SCOPES = [
  { value: "gate:invoke", label: "gate:invoke — ask for a verdict (what agents need)" },
  { value: "graph:read", label: "graph:read — read the map" },
  { value: "rationale:confirm", label: "rationale:confirm — move the coverage metric" },
  { value: "connector:manage", label: "connector:manage — configure connectors" },
];

export default function ApiKeysPane() {
  const { capabilities } = useSession();
  const keys = useQuery<{ items: ApiKeyRow[] }>("/api/api-keys");
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [selected, setSelected] = useState<string[]>(["gate:invoke"]);
  const [fresh, setFresh] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const items = (keys.data?.items ?? []).filter((k) => k.revokedAt === null);

  async function create() {
    setError(null);
    try {
      const created = await api.post<{ key: string }>("/api/api-keys", {
        name,
        scopes: selected,
      });
      setFresh(created.key);
      setCopied(false);
      setCreating(false);
      setName("");
      keys.reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.userMessage : "Could not create the key");
    }
  }

  async function revoke(id: number, label: string) {
    if (!window.confirm(`Revoke ${label}? The next API call with it will fail.`)) return;
    await api.delete(`/api/api-keys/${id}`).catch(() => undefined);
    keys.reload();
  }

  return (
    <>
      {fresh && (
        <section className="panel" style={{ borderColor: "var(--thread)" }}>
          <h2 className="panel__title">Your new key</h2>
          <p className="panel__caption">
            This is the only time the full key is shown. It is stored hashed — we cannot
            show it to you again, and a leaked backup does not leak usable keys.
          </p>
          <div
            style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}
          >
            <code
              className="mono"
              style={{
                background: "var(--panel)",
                padding: "8px 12px",
                borderRadius: 8,
                fontSize: 13,
                overflowWrap: "anywhere",
              }}
              data-testid="apikey-fresh"
            >
              {fresh}
            </code>
            <button
              type="button"
              className="btn btn--ink btn--tiny"
              onClick={() => {
                navigator.clipboard?.writeText(fresh);
                setCopied(true);
              }}
            >
              {copied ? "Copied" : "Copy"}
            </button>
            <button
              type="button"
              className="btn btn--ghost btn--tiny"
              onClick={() => setFresh(null)}
            >
              Done — hide it
            </button>
          </div>
        </section>
      )}

      <section className="panel">
        <h2 className="panel__title">API keys</h2>
        <p className="panel__caption">
          These authenticate the REST gate and the MCP server. A key can only be granted
          capabilities its creator already holds.
        </p>

        {keys.loading ? (
          <div style={{ height: 80, opacity: 0.4 }} />
        ) : items.length === 0 ? (
          <EmptyState
            title="No keys yet"
            body="Create one to let a script or an AI agent ask for verdicts."
          />
        ) : (
          <table className="dtable">
            <thead>
              <tr>
                <th>Name</th>
                <th>Key</th>
                <th>Capabilities</th>
                <th>Last used</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {items.map((key) => (
                <tr key={key.id}>
                  <td>
                    <strong>{key.name}</strong>
                  </td>
                  <td className="mono dim">{key.prefix}</td>
                  <td>
                    {key.scopes.map((s) => (
                      <span key={s} className="tag" style={{ marginRight: 4 }}>
                        {s}
                      </span>
                    ))}
                  </td>
                  <td className="dim">
                    {key.lastUsedAt ? new Date(key.lastUsedAt).toLocaleString() : "never"}
                  </td>
                  <td>
                    <button
                      type="button"
                      className="btn btn--danger-ghost btn--tiny"
                      onClick={() => void revoke(key.id, key.name)}
                      data-testid={`apikey-revoke-${key.id}`}
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

      <section className="panel">
        <h2 className="panel__title">Create a key</h2>
        {error && (
          <p style={{ color: "var(--block)", fontSize: 13.5 }} role="alert">
            {error}
          </p>
        )}
        {!creating ? (
          <button
            type="button"
            className="btn btn--ink btn--small"
            onClick={() => setCreating(true)}
            data-testid="apikey-create"
          >
            New API key
          </button>
        ) : (
          <div
            style={{ display: "flex", flexDirection: "column", gap: 12, maxWidth: 480 }}
          >
            <div className="field-inline">
              <label htmlFor="key-name">Name</label>
              <input
                id="key-name"
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="deploy-bot"
              />
            </div>
            <fieldset
              style={{
                border: 0,
                padding: 0,
                margin: 0,
                display: "flex",
                flexDirection: "column",
                gap: 6,
              }}
            >
              <legend
                className="field-inline"
                style={{ fontWeight: 500, marginBottom: 6 }}
              >
                Capabilities
              </legend>
              {SCOPES.filter((s) => capabilities.includes(s.value)).map((scope) => (
                <label
                  key={scope.value}
                  style={{
                    display: "flex",
                    gap: 8,
                    fontSize: 13.5,
                    alignItems: "center",
                  }}
                >
                  <input
                    type="checkbox"
                    checked={selected.includes(scope.value)}
                    onChange={(e) =>
                      setSelected((prev) =>
                        e.target.checked
                          ? [...prev, scope.value]
                          : prev.filter((s) => s !== scope.value),
                      )
                    }
                  />
                  <span className="mono" style={{ fontSize: 12.5 }}>
                    {scope.label}
                  </span>
                </label>
              ))}
            </fieldset>
            <div style={{ display: "flex", gap: 8 }}>
              <button
                type="button"
                className="btn btn--ink btn--small"
                disabled={!name.trim() || selected.length === 0}
                onClick={() => void create()}
              >
                Create
              </button>
              <button
                type="button"
                className="btn btn--ghost btn--small"
                onClick={() => setCreating(false)}
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </section>

      <McpConnect />
    </>
  );
}

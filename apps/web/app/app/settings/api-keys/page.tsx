"use client";

import { useState } from "react";
import { API_KEYS, timeAgo } from "../../../../lib/mock/data";

const SCOPES = ["gate:invoke", "graph:read", "rationale:confirm", "connector:manage"];

export default function ApiKeysPane() {
  const [creating, setCreating] = useState(false);
  const [freshKey, setFreshKey] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [revoked, setRevoked] = useState<Set<string>>(new Set());

  return (
    <>
      {freshKey && (
        <section
          className="panel"
          style={{ marginBottom: 16, borderColor: "var(--thread)" }}
        >
          <h2 className="panel__title">Your new key</h2>
          <p className="panel__caption">
            This is the only time the full key is shown. It will never be shown again.
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
              }}
              data-testid="apikey-fresh"
            >
              {freshKey}
            </code>
            <button
              type="button"
              className="btn btn--ink btn--tiny"
              onClick={() => {
                navigator.clipboard?.writeText(freshKey);
                setCopied(true);
              }}
            >
              {copied ? "Copied" : "Copy"}
            </button>
            <button
              type="button"
              className="btn btn--ghost btn--tiny"
              onClick={() => setFreshKey(null)}
            >
              Done — hide it
            </button>
          </div>
        </section>
      )}

      <section className="panel" style={{ marginBottom: 16 }}>
        <h2 className="panel__title">API keys</h2>
        <p className="panel__caption">
          Scopes are limited to your own capabilities. Keys drive the proxy gate and MCP
          server.
        </p>
        <table className="dtable">
          <thead>
            <tr>
              <th>Name</th>
              <th>Key</th>
              <th>Scopes</th>
              <th>Last used</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {API_KEYS.filter((k) => !revoked.has(k.id)).map((k) => (
              <tr key={k.id}>
                <td>
                  <strong>{k.name}</strong>
                  <div className="dim" style={{ fontSize: 12 }}>
                    by {k.createdBy}
                  </div>
                </td>
                <td className="mono dim">{k.prefix}</td>
                <td>
                  {k.scopes.map((s) => (
                    <span key={s} className="tag" style={{ marginRight: 4 }}>
                      {s}
                    </span>
                  ))}
                </td>
                <td className="dim">{k.lastUsedAt ? timeAgo(k.lastUsedAt) : "never"}</td>
                <td>
                  <button
                    type="button"
                    className="btn btn--danger-ghost btn--tiny"
                    onClick={() => {
                      if (
                        window.confirm(
                          `Revoke ${k.name}? The next API call with it will 401.`,
                        )
                      ) {
                        setRevoked((r) => new Set(r).add(k.id));
                      }
                    }}
                    data-testid={`apikey-revoke-${k.id}`}
                  >
                    Revoke
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="panel">
        <h2 className="panel__title">Create a key</h2>
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
          <form
            style={{ display: "flex", flexDirection: "column", gap: 12, maxWidth: 420 }}
            onSubmit={(e) => {
              e.preventDefault();
              setFreshKey(
                `sdk_live_${crypto.randomUUID().replaceAll("-", "").slice(0, 32)}`,
              );
              setCopied(false);
              setCreating(false);
            }}
          >
            <div className="field-inline">
              <label htmlFor="key-name">Name</label>
              <input id="key-name" type="text" required placeholder="deploy-bot" />
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
                Scopes
              </legend>
              {SCOPES.map((s) => (
                <label
                  key={s}
                  style={{
                    display: "flex",
                    gap: 8,
                    fontSize: 13.5,
                    alignItems: "center",
                  }}
                >
                  <input type="checkbox" defaultChecked={s === "gate:invoke"} />{" "}
                  <code className="mono">{s}</code>
                </label>
              ))}
            </fieldset>
            <div style={{ display: "flex", gap: 8 }}>
              <button type="submit" className="btn btn--ink btn--small">
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
          </form>
        )}
      </section>
    </>
  );
}

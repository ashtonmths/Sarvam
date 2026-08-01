"use client";

import { useState } from "react";
import { ApiError, api } from "../../lib/api";
import { API_URL } from "../../lib/env";
import { useQuery } from "../../lib/queries";

/**
 * Connecting a system, from the app.
 *
 * The API has had the three calls this needs since the connector framework
 * landed, and the settings pane only ever listed what already existed - so the
 * one connector anybody had was the one `pnpm seed` created, and Slack and
 * GitHub were unreachable without a database insert.
 *
 * Three calls, in this order, because the middle one is what moves an instance
 * out of pending_auth:
 *
 *   POST /api/connectors/:slug/instances     the instance, with non-secret config
 *   PUT  /api/instances/:id/credential/read  the secret, into the vault
 *   POST /api/instances/:id/test             health, so the answer is now
 *
 * The secret never goes in `config`: the API rejects any config key matching
 * /token|key|secret|password/, which is the server refusing to hold a
 * credential somewhere it would be readable back.
 */

interface ConfigField {
  name: string;
  label: string;
  placeholder: string;
  required?: boolean;
  /** Comma-separated input that posts as an array. */
  list?: boolean;
  /**
   * Mining scope rather than connector config. What the Historian is allowed
   * to read lives in its own table, queried per org and connector, so a
   * channel written into `config` would sit there being read by nothing.
   */
  scope?: "slack" | "github";
  help?: string;
}

interface Form {
  /** What the vault records this credential as. */
  credentialKind: string;
  credentialLabel: string;
  credentialPlaceholder: string;
  /** Where the customer gets the value. Written for the person pasting it. */
  credentialHelp: string;
  fields: ConfigField[];
}

const FORMS: Record<string, Form> = {
  postgres: {
    credentialKind: "connection_string",
    credentialLabel: "Connection string",
    credentialPlaceholder: "postgres://sadhak_ro:password@host:5432/database",
    credentialHelp:
      "Use a read-only role. Sadhak requests no table SELECT at all — catalog visibility is enough to read structure.",
    fields: [],
  },
  n8n: {
    credentialKind: "api_key",
    credentialLabel: "API key",
    credentialPlaceholder: "n8n_api_...",
    credentialHelp:
      "Mint it in n8n under Settings → API. There is no endpoint that issues one, so this step is manual.",
    fields: [
      {
        name: "baseUrl",
        label: "n8n URL",
        placeholder: "http://localhost:5678",
        required: true,
        help: "Where n8n is reachable from the API container.",
      },
    ],
  },
  airtable: {
    credentialKind: "api_key",
    credentialLabel: "Personal access token",
    credentialPlaceholder: "pat...",
    credentialHelp:
      "Create it at airtable.com/create/tokens with the schema.bases:read scope. Sadhak reads base, table and field names, never record contents.",
    fields: [
      {
        name: "bases",
        label: "Base IDs",
        placeholder: "appAbc123, appXyz789",
        list: true,
        help: "Comma separated. Leave empty to crawl every base the token can see.",
      },
    ],
  },
  slack: {
    // oauth_access, not bot_token, and the name is load bearing. The Historian
    // and Reflex both fetch this credential by kind, so a Slack token stored
    // under any other name is invisible to them — while the connector test
    // still passes, because that path takes whichever read credential exists.
    // The failure is a Slack connector that looks connected and mines nothing.
    credentialKind: "oauth_access",
    credentialLabel: "Bot user OAuth token",
    credentialPlaceholder: "xoxb-...",
    credentialHelp:
      "From your Slack app under OAuth & Permissions. It needs channels:read, and channels:history only for the channels listed above.",
    fields: [
      {
        name: "channels",
        label: "Channels to mine",
        placeholder: "C01ABC123, C09XYZ456",
        list: true,
        scope: "slack",
        help: "Comma separated channel IDs. The Historian reads only these, and nothing is mined until you list one.",
      },
    ],
  },
  github: {
    credentialKind: "token",
    credentialLabel: "Access token",
    credentialPlaceholder: "ghp_... or ghs_...",
    credentialHelp:
      "A fine-grained token with metadata:read, contents:read and pull_requests:read. This one authenticates the crawl. Mining pull requests and commits reads GITHUB_TOKEN from the deployment environment instead, and the merge gate needs the GitHub App below — three separate paths, and this form only sets the first.",
    fields: [
      {
        name: "repos",
        label: "Repositories to mine",
        placeholder: "acme/billing, acme/infra",
        list: true,
        scope: "github",
        help: "Comma separated, each as owner/repo. The Historian appends these as repo: qualifiers, so it can never search outside them.",
      },
    ],
  },
};

export function AddConnector({
  slugs,
  onAdded,
}: {
  slugs: Array<{ slug: string; displayName: string }>;
  onAdded: (message: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [slug, setSlug] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Whether the deployment has Slack OAuth credentials. Asked of the server
  // rather than inferred, so the paste-a-token path stays the honest fallback
  // on a deployment that has not registered a Slack app.
  const oauth = useQuery<{ configured: boolean }>("/api/connectors/slack/oauth/status");
  const [manual, setManual] = useState(false);

  const form = slug ? FORMS[slug] : undefined;

  function reset() {
    setOpen(false);
    setSlug("");
    setError(null);
    setManual(false);
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!form) return;

    const data = new FormData(event.currentTarget);
    const displayName = String(data.get("displayName") ?? "").trim();
    const credential = String(data.get("credential") ?? "").trim();
    if (!displayName || !credential) return;

    const config: Record<string, unknown> = {};
    const scopes: Array<{ connector: "slack" | "github"; scopeValue: string }> = [];

    for (const field of form.fields) {
      const raw = String(data.get(field.name) ?? "").trim();
      if (!raw) continue;

      const values = field.list
        ? raw
            .split(",")
            .map((part) => part.trim())
            .filter(Boolean)
        : [raw];

      if (field.scope) {
        for (const scopeValue of values) {
          scopes.push({ connector: field.scope, scopeValue });
        }
        continue;
      }

      config[field.name] = field.list ? values : raw;
    }

    setBusy(true);
    setError(null);
    try {
      const instance = await api.post<{ id: number }>(
        `/api/connectors/${slug}/instances`,
        { displayName, config },
      );

      // The instance exists but sits in pending_auth until this lands, so a
      // failure here leaves a visible half-connected row rather than a silent
      // one. That is deliberate: the row is recoverable from the list.
      await api.put(`/api/instances/${instance.id}/credential/read`, {
        kind: form.credentialKind,
        value: credential,
      });

      // What the Historian may read is a separate record from the connector,
      // and it is what gates mining: with no scope rows, searchSlack returns
      // an empty list before it ever reaches for a token.
      for (const scope of scopes) {
        await api.post("/api/mining-scopes", scope);
      }

      const health = await api
        .post<{ ok: boolean; detail?: string }>(`/api/instances/${instance.id}/test`)
        .catch(() => ({ ok: false, detail: "the connection test did not complete" }));

      onAdded(
        health.ok
          ? `${displayName} connected. Crawl it to put it on the map.`
          : `${displayName} saved, but the connection test failed — ${health.detail}`,
      );
      reset();
    } catch (err) {
      setError(
        err instanceof ApiError ? err.userMessage : "Could not connect that system",
      );
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button type="button" className="btn btn--ink" onClick={() => setOpen(true)}>
        Connect a system
      </button>
    );
  }

  return (
    <form className="connect" onSubmit={submit}>
      <div className="connect__head">
        <h3 className="connect__title">Connect a system</h3>
        <button type="button" className="btn btn--ghost btn--small" onClick={reset}>
          Cancel
        </button>
      </div>

      <div className="field">
        <label htmlFor="connector">System</label>
        <select
          id="connector"
          name="connector"
          value={slug}
          required
          onChange={(event) => {
            setSlug(event.target.value);
            setError(null);
          }}
        >
          <option value="">Choose one</option>
          {slugs.map((option) => (
            <option key={option.slug} value={option.slug}>
              {option.displayName}
            </option>
          ))}
        </select>
      </div>

      {slug === "slack" && oauth.data?.configured && (
        <div className="connect__oauth">
          <p>
            Sadhak asks Slack for permission and stores both tokens itself. You pick the
            channels from a list afterwards, so there is no ID to look up and no token to
            copy.
          </p>
          <a
            className="btn btn--ink"
            href={`${API_URL}/api/connectors/slack/oauth/start`}
          >
            Connect Slack
          </a>
          <button
            type="button"
            className="connect__manual"
            onClick={() => setManual(true)}
            hidden={manual}
          >
            Paste a bot token instead
          </button>
        </div>
      )}

      {form && (slug !== "slack" || manual || !oauth.data?.configured) && (
        <>
          <div className="field">
            <label htmlFor="displayName">Name it</label>
            <input
              id="displayName"
              name="displayName"
              placeholder="Production billing"
              required
            />
            <p className="field__help">What this system is called in your team.</p>
          </div>

          {form.fields.map((field) => (
            <div className="field" key={field.name}>
              <label htmlFor={field.name}>{field.label}</label>
              <input
                id={field.name}
                name={field.name}
                placeholder={field.placeholder}
                required={field.required}
              />
              {field.help && <p className="field__help">{field.help}</p>}
            </div>
          ))}

          <div className="field">
            <label htmlFor="credential">{form.credentialLabel}</label>
            <input
              id="credential"
              name="credential"
              type="password"
              placeholder={form.credentialPlaceholder}
              autoComplete="off"
              required
            />
            <p className="field__help">{form.credentialHelp}</p>
          </div>

          <p className="connect__vault">
            Sealed with AES-256-GCM before it reaches the database and bound to this
            organisation. There is no endpoint anywhere in the API that reads a credential
            back.
          </p>

          {error && (
            <p className="banner banner--warn" role="alert">
              {error}
            </p>
          )}

          <button type="submit" className="btn btn--ink" disabled={busy}>
            {busy ? "Connecting…" : "Connect and test"}
          </button>
        </>
      )}
    </form>
  );
}

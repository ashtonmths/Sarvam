"use client";

import { useState } from "react";
import { ApiError, api } from "../../lib/api";
import { useQuery } from "../../lib/queries";

/**
 * Where Sadhak posts when something breaks.
 *
 * This setting had an API and no interface, which made it invisible rather than
 * optional — and it is a hard gate: with no channel, a workflow failure is
 * detected, traversed, searched and diagnosed, and then the alert returns false
 * and nobody is told. The most expensive path in the product ended in silence
 * because of a field only reachable by curl.
 *
 * Kept separate from the mining checkboxes above it on purpose. Those decide
 * what Sadhak may *read*; this decides where it *writes*. Conflating the two is
 * how a team ends up broadcasting incidents into whichever channel happened to
 * be ticked for retrieval.
 */

interface Channel {
  id: string;
  name: string;
  isPrivate: boolean;
  members: number;
}

interface Settings {
  slackChannelId: string | null;
  alertThreshold: "APPROVE" | "WARN" | "BLOCK";
  dmActor: boolean;
}

export function AlertChannel() {
  const channels = useQuery<{ channels: Channel[] }>("/api/connectors/slack/channels");
  const settings = useQuery<Settings>("/api/reflex/settings");

  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const current = settings.data?.slackChannelId ?? "";
  const list = channels.data?.channels ?? [];

  async function save(next: Partial<Settings>) {
    setBusy(true);
    setError(null);
    setSaved(null);
    try {
      await api.put<Settings>("/api/reflex/settings", next);
      settings.reload();
      setSaved("Saved.");
    } catch (err) {
      setError(err instanceof ApiError ? err.userMessage : "That did not save.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="alertch">
      <p className="panel__caption">
        Incident alerts, merge-gate escalations and workflow diagnoses are posted here.
        The bot must be a member — invite it with{" "}
        <code className="mono">/invite @Sadhak</code> in the channel first.
      </p>

      <div className="field">
        <label htmlFor="alert-channel">Channel</label>
        <select
          id="alert-channel"
          value={current}
          disabled={busy || channels.loading}
          onChange={(e) => save({ slackChannelId: e.target.value || null })}
        >
          <option value="">No channel — nothing is posted</option>
          {list.map((channel) => (
            <option key={channel.id} value={channel.id}>
              #{channel.name}
              {channel.isPrivate ? " (private)" : ""}
            </option>
          ))}
        </select>
      </div>

      <div className="field">
        <label htmlFor="alert-threshold">Post when a verdict is at least</label>
        <select
          id="alert-threshold"
          value={settings.data?.alertThreshold ?? "WARN"}
          disabled={busy}
          onChange={(e) =>
            save({ alertThreshold: e.target.value as Settings["alertThreshold"] })
          }
        >
          {/* APPROVE last and described plainly: a ping per green change is
              precisely how this bot gets muted. */}
          <option value="BLOCK">BLOCK — only changes that were stopped</option>
          <option value="WARN">WARN — anything with surfaced impact</option>
          <option value="APPROVE">APPROVE — every decision, including green ones</option>
        </select>
      </div>

      {/*
        Stated rather than hidden. A channel list that comes back empty almost
        always means the token predates the scopes rather than that the
        workspace has no channels, and "reconnect" is an instruction the reader
        can act on where an empty dropdown is not.
      */}
      {!channels.loading && list.length === 0 && (
        <div className="banner banner--warn" role="status">
          No channels came back. The stored Slack token is probably older than the scopes
          Sadhak now asks for — reconnect Slack above, and make sure the Slack app itself
          grants <code className="mono">channels:read</code> and{" "}
          <code className="mono">chat:write</code>.
        </div>
      )}

      {error && (
        <div className="banner banner--warn" role="status">
          {error}
        </div>
      )}
      {saved && <p className="alertch__saved">{saved}</p>}
    </div>
  );
}

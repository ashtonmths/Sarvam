"use client";

import { useState } from "react";
import { ApiError, api } from "../../lib/api";
import { useQuery } from "../../lib/queries";

/**
 * Which channels the Historian may read.
 *
 * Ticking a box is not a preference — it grants read access to a channel's
 * history and puts the app in that channel, both visible to everyone in the
 * workspace. So each row states what it does, and the result of the join comes
 * back per channel rather than as one optimistic "saved".
 *
 * Nothing is mined until a box is ticked. That is enforced in the Historian,
 * which returns an empty result before it reaches for a token when the scope
 * list is empty, and it is worth saying on the surface where the choice is made.
 */

interface Channel {
  id: string;
  name: string;
  isPrivate: boolean;
  members: number;
}

export function SlackChannels() {
  const data = useQuery<{ channels: Channel[]; selected: string[] }>(
    "/api/connectors/slack/channels",
  );
  const [busy, setBusy] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");

  const channels = data.data?.channels ?? [];
  const selected = new Set(data.data?.selected ?? []);

  async function toggle(channel: Channel, enabled: boolean) {
    setBusy(channel.id);
    setError(null);
    try {
      const result = await api.put<{ joined?: boolean; detail: string }>(
        `/api/connectors/slack/channels/${channel.id}/mining`,
        { enabled },
      );
      setNotes((prev) => ({ ...prev, [channel.id]: result.detail }));
      data.reload();
    } catch (err) {
      setError(
        err instanceof ApiError ? err.userMessage : "Could not change that channel",
      );
    } finally {
      setBusy(null);
    }
  }

  // Listing goes over the network to Slack, so this is a real wait rather than
  // a flicker — and while it ran the empty branch below rendered "no channels"
  // on a workspace that has three.
  if (data.loading) {
    return (
      <p className="dim" style={{ fontSize: 13 }}>
        Asking Slack which channels it can see…
      </p>
    );
  }

  // An error read as "no channels" before, which sends somebody to check their
  // scopes when the request never arrived.
  if (data.error) {
    return (
      <p className="banner banner--warn" role="alert">
        {data.error}
      </p>
    );
  }

  if (channels.length === 0) {
    return (
      <p className="dim" style={{ fontSize: 13.5 }}>
        Slack returned no channels. The app needs channels:read, and it only sees channels
        that exist in the workspace it was installed into.
      </p>
    );
  }

  const shown = filter
    ? channels.filter((c) => c.name.toLowerCase().includes(filter.toLowerCase()))
    : channels;

  return (
    <div className="chanpick">
      <div className="chanpick__head">
        <input
          className="chanpick__filter"
          placeholder="Filter channels"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          aria-label="Filter channels"
        />
        <span className="chanpick__count">
          {selected.size} of {channels.length} mined
        </span>
      </div>

      {error && (
        <p className="banner banner--warn" role="alert">
          {error}
        </p>
      )}

      <ul className="chanpick__list">
        {shown.map((channel) => {
          const on = selected.has(channel.id);
          return (
            <li key={channel.id} className="chanpick__row">
              <label className="chanpick__label">
                <input
                  type="checkbox"
                  checked={on}
                  disabled={busy === channel.id}
                  onChange={(event) => void toggle(channel, event.target.checked)}
                />
                <span className="chanpick__name">
                  {channel.isPrivate ? "🔒" : "#"}
                  {channel.name}
                </span>
              </label>
              <span className="chanpick__meta">
                {notes[channel.id] ??
                  (channel.members > 0 ? `${channel.members} members` : "")}
              </span>
            </li>
          );
        })}
      </ul>

      <p className="chanpick__note">
        Ticking a channel adds Sadhak to it and lets the Historian read its history.
        Private channels cannot be joined by any app — invite Sadhak from inside Slack
        with <code className="mono">/invite</code>, then tick it here.
      </p>
    </div>
  );
}

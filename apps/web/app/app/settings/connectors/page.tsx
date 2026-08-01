"use client";

import { useState } from "react";
import { AddConnector } from "../../../../components/app/add-connector";
import { SlackChannels } from "../../../../components/app/slack-channels";
import { EmptyState } from "../../../../components/app/ui";
import {
  GlyphBranch,
  GlyphChat,
  GlyphDb,
  GlyphFlow,
  GlyphGrid,
} from "../../../../components/marks";
import { ApiError, api } from "../../../../lib/api";
import { useQuery } from "../../../../lib/queries";

interface Descriptor {
  slug: string;
  displayName: string;
  auth: string;
  readScopes: Array<{ scope: string; purpose: string }>;
  writeScopes: Array<{ scope: string; purpose: string }>;
}

interface Instance {
  id: number;
  connector: string;
  displayName: string;
  status: string;
  statusDetail: string | null;
  lastCrawlAt: string | null;
  lastCrawlError: string | null;
  config: Record<string, unknown>;
}

interface GithubInstallation {
  installationId: number;
  accountLogin: string | null;
  enforcing: boolean | null;
}

const GLYPH: Record<string, React.ReactNode> = {
  postgres: <GlyphDb />,
  n8n: <GlyphFlow />,
  airtable: <GlyphGrid />,
  github: <GlyphBranch />,
  slack: <GlyphChat />,
};

export default function ConnectorsPane() {
  const data = useQuery<{
    descriptors: Descriptor[];
    instances: Instance[];
    vaultAvailable: boolean;
  }>("/api/connectors");
  const github = useQuery<{
    configured: boolean;
    items: GithubInstallation[];
    note: string;
  }>("/api/github/installations");

  const [busy, setBusy] = useState<number | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function crawlNow(id: number) {
    setBusy(id);
    setNotice(null);
    try {
      await api.post(`/api/instances/${id}/crawl`);
      setNotice("Crawl queued — the graph updates as it completes.");
    } catch (err) {
      setNotice(err instanceof ApiError ? err.userMessage : "Could not queue the crawl");
    } finally {
      setBusy(null);
      data.reload();
    }
  }

  async function test(id: number) {
    setBusy(id);
    try {
      const result = await api.post<{ ok: boolean; detail?: string }>(
        `/api/instances/${id}/test`,
      );
      setNotice(
        result.ok ? `Connection healthy — ${result.detail}` : `Failed — ${result.detail}`,
      );
    } catch (err) {
      setNotice(
        err instanceof ApiError ? err.userMessage : "Could not test the connection",
      );
    } finally {
      setBusy(null);
      data.reload();
    }
  }

  const instances = data.data?.instances ?? [];
  const descriptors = data.data?.descriptors ?? [];

  return (
    <>
      {notice && (
        <div className="banner banner--info" role="status">
          {notice}
        </div>
      )}

      {data.data && !data.data.vaultAvailable && (
        <div className="banner banner--warn" role="status">
          No <code className="mono">CREDENTIAL_MASTER_KEY</code> is configured, so
          credentials cannot be stored. Existing connections still crawl; new ones cannot
          be added.
        </div>
      )}

      <section className="panel" style={{ marginBottom: 16 }}>
        <h2 className="panel__title">Connected systems</h2>
        <p className="panel__caption">
          Crawls are read-only. Every requested permission is listed below, verbatim —
          this is the page to send a security reviewer.
        </p>

        {data.loading ? (
          <div style={{ height: 100, opacity: 0.4 }} />
        ) : instances.length === 0 ? (
          <EmptyState
            title="No connectors yet"
            body="Everything downstream — the graph, verdicts, agents, metrics — starts with one read-only connection."
          />
        ) : (
          instances.map((instance) => {
            const descriptor = descriptors.find((d) => d.slug === instance.connector);
            return (
              <div
                key={instance.id}
                className="conn-row"
                data-testid={`connector-${instance.connector}`}
              >
                {GLYPH[instance.connector]}
                <div className="conn-row__meta">
                  <strong>{instance.displayName}</strong>
                  <span>
                    {instance.statusDetail ??
                      (instance.lastCrawlAt
                        ? `Last crawled ${new Date(instance.lastCrawlAt).toLocaleString()}`
                        : "Never crawled")}
                  </span>
                  {descriptor && (
                    <ul className="scope-list">
                      {descriptor.readScopes.map((scope) => (
                        <li key={scope.scope} title={scope.purpose}>
                          {scope.scope}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
                <span
                  className={`tag ${
                    instance.status === "active"
                      ? "tag--green"
                      : instance.status === "degraded"
                        ? "tag--amber"
                        : instance.status === "error"
                          ? "tag--red"
                          : ""
                  }`}
                >
                  {instance.status}
                </span>
                <button
                  type="button"
                  className="btn btn--ghost btn--tiny"
                  disabled={busy === instance.id}
                  onClick={() => void test(instance.id)}
                >
                  Test
                </button>
                <button
                  type="button"
                  className="btn btn--ghost btn--tiny"
                  disabled={busy === instance.id}
                  onClick={() => void crawlNow(instance.id)}
                  data-testid={`connector-crawl-${instance.connector}`}
                >
                  {busy === instance.id ? "Working…" : "Crawl now"}
                </button>
              </div>
            );
          })
        )}

        <div className="conn-add">
          <AddConnector
            slugs={descriptors.map((d) => ({
              slug: d.slug,
              displayName: d.displayName,
            }))}
            onAdded={(message) => {
              setNotice(message);
              data.reload();
            }}
          />
        </div>
      </section>

      {instances.some((i) => i.connector === "slack") && (
        <section className="panel" style={{ marginBottom: 16 }}>
          <h2 className="panel__title">Slack channels</h2>
          <p className="panel__caption">
            Nothing is mined until a channel is ticked. Each one grants the Historian read
            access to that channel's history and puts Sadhak in it.
          </p>
          <SlackChannels />
        </section>
      )}

      <section className="panel">
        <h2 className="panel__title">GitHub</h2>
        <p className="panel__caption">
          The hard gate — a check that turns red on BLOCK and, with branch protection on,
          disables the merge button.
        </p>

        {!github.data?.configured ? (
          <div className="banner banner--warn" role="status">
            The GitHub App is not configured on this deployment. Set{" "}
            <code className="mono">GITHUB_APP_ID</code>,{" "}
            <code className="mono">GITHUB_APP_PRIVATE_KEY</code> and{" "}
            <code className="mono">GITHUB_APP_WEBHOOK_SECRET</code>, then restart.
          </div>
        ) : (github.data.items ?? []).length === 0 ? (
          <p className="dim" style={{ fontSize: 13.5 }}>
            No installations linked to this organization yet.
          </p>
        ) : (
          github.data.items.map((install) => (
            <div key={install.installationId} className="conn-row">
              <GlyphBranch />
              <div className="conn-row__meta">
                <strong>
                  {install.accountLogin ?? `Installation ${install.installationId}`}
                </strong>
                <span>installation {install.installationId}</span>
              </div>
              {install.enforcing === true ? (
                <span className="tag tag--green">enforcing</span>
              ) : (
                <span className="tag tag--amber">installed, not enforcing</span>
              )}
            </div>
          ))
        )}

        {github.data?.configured &&
          (github.data.items ?? []).some((i) => i.enforcing !== true) && (
            <div className="banner banner--warn" style={{ marginTop: 12 }} role="status">
              {/* Believing you are protected when you are not is worse than
                having no gate at all, so this state is stated plainly. */}
              <span>
                The check runs, but branch protection does not require it — a BLOCK is
                currently advisory. In GitHub:{" "}
                <strong>Settings → Branches → Require status checks</strong>, then select{" "}
                <code className="mono">sadhak/gate</code>.
              </span>
            </div>
          )}
      </section>
    </>
  );
}

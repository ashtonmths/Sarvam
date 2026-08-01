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

/** active / degraded / error / pending_auth, as a dot and a word. */
function StatusDot({ status }: { status: string }) {
  return (
    <span className={`cstat cstat--${status}`}>
      <span className="cstat__dot" />
      {status.replace("_", " ")}
    </span>
  );
}

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

      <section className="panel">
        <div className="panel__head">
          <div>
            <h2 className="panel__title">Connected systems</h2>
            <p className="panel__caption">
              Every crawl is read-only, and every permission each one holds is listed on
              its own card — this is the page to send a security reviewer.
            </p>
          </div>
        </div>

        {data.loading ? (
          <div style={{ height: 120, opacity: 0.4 }} />
        ) : instances.length === 0 ? (
          <EmptyState
            title="Nothing connected yet"
            body="Everything downstream — the graph, verdicts, agents, metrics — starts with one read-only connection."
          />
        ) : (
          <div className="cgrid">
            {instances.map((instance) => {
              const descriptor = descriptors.find((d) => d.slug === instance.connector);
              const scopes = descriptor?.readScopes ?? [];
              const working = busy === instance.id;

              return (
                <article
                  key={instance.id}
                  className="ccard"
                  data-testid={`connector-${instance.connector}`}
                >
                  <header className="ccard__head">
                    <span className="ccard__glyph">{GLYPH[instance.connector]}</span>
                    <div className="ccard__id">
                      <h3 className="ccard__name">{instance.displayName}</h3>
                      <span className="ccard__kind">
                        {descriptor?.displayName ?? instance.connector}
                      </span>
                    </div>
                    <StatusDot status={instance.status} />
                  </header>

                  {/* One line, and it is the one a reader wants: why it is not
                      healthy, or when it last ran. Not both — a status detail
                      only exists when something is worth saying. */}
                  <p className="ccard__state">
                    {instance.statusDetail ??
                      instance.lastCrawlError ??
                      (instance.lastCrawlAt
                        ? `Last crawled ${new Date(instance.lastCrawlAt).toLocaleString()}`
                        : "Never crawled")}
                  </p>

                  {scopes.length > 0 && (
                    // Collapsed by default. Permissions are the answer to a
                    // question asked once during review, and leaving them open
                    // made every card a different height and buried the status.
                    <details className="ccard__scopes">
                      <summary>
                        {scopes.length} permission{scopes.length === 1 ? "" : "s"}
                      </summary>
                      <ul>
                        {scopes.map((scope) => (
                          <li key={scope.scope}>
                            <code className="mono">{scope.scope}</code>
                            <span>{scope.purpose}</span>
                          </li>
                        ))}
                      </ul>
                    </details>
                  )}

                  {instance.connector === "slack" && (
                    <div className="ccard__extra">
                      <h4 className="ccard__sub">Channels the Historian may read</h4>
                      <SlackChannels />
                    </div>
                  )}

                  <footer className="ccard__foot">
                    <button
                      type="button"
                      className="btn btn--ghost btn--tiny"
                      disabled={working}
                      onClick={() => void test(instance.id)}
                    >
                      Test
                    </button>
                    <button
                      type="button"
                      className="btn btn--ghost btn--tiny"
                      disabled={working}
                      onClick={() => void crawlNow(instance.id)}
                      data-testid={`connector-crawl-${instance.connector}`}
                    >
                      {working ? "Working…" : "Crawl now"}
                    </button>
                  </footer>
                </article>
              );
            })}
          </div>
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

      <section className="panel">
        <h2 className="panel__title">The merge gate</h2>
        <p className="panel__caption">
          A GitHub check that turns red on BLOCK. With branch protection requiring it, the
          merge button is disabled — this is the one place a change can genuinely be
          stopped rather than reversed.
        </p>

        {!github.data?.configured ? (
          <div className="gh-setup">
            <p>
              The GitHub App is not configured on this deployment. Set these, then
              restart:
            </p>
            {/* A list, not a sentence. Three variable names inline wrapped
                mid-name and orphaned the words after them. */}
            <ul className="gh-setup__vars">
              <li>
                <code className="mono">GITHUB_APP_ID</code>
              </li>
              <li>
                <code className="mono">GITHUB_APP_PRIVATE_KEY</code>
              </li>
              <li>
                <code className="mono">GITHUB_APP_WEBHOOK_SECRET</code>
              </li>
            </ul>
          </div>
        ) : (github.data.items ?? []).length === 0 ? (
          <p className="dim" style={{ fontSize: 13.5 }}>
            No installations linked to this organization yet.
          </p>
        ) : (
          <div className="cgrid">
            {github.data.items.map((install) => (
              <article key={install.installationId} className="ccard">
                <header className="ccard__head">
                  <span className="ccard__glyph">
                    <GlyphBranch />
                  </span>
                  <div className="ccard__id">
                    <h3 className="ccard__name">
                      {install.accountLogin ?? `Installation ${install.installationId}`}
                    </h3>
                    <span className="ccard__kind">
                      installation {install.installationId}
                    </span>
                  </div>
                  <StatusDot
                    status={install.enforcing === true ? "active" : "degraded"}
                  />
                </header>
                <p className="ccard__state">
                  {install.enforcing === true
                    ? "Branch protection requires the check, so a BLOCK stops the merge."
                    : "The check runs but branch protection does not require it, so a BLOCK is advisory."}
                </p>
                {install.enforcing !== true && (
                  // Believing you are protected when you are not is worse than
                  // having no gate at all, so the fix is on the card rather
                  // than in a banner underneath the list.
                  <p className="ccard__fix">
                    In GitHub:{" "}
                    <strong>Settings → Branches → Require status checks</strong>, then
                    select <code className="mono">sadhak/gate</code>.
                  </p>
                )}
              </article>
            ))}
          </div>
        )}
      </section>
    </>
  );
}

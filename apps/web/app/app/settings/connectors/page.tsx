"use client";

import { useState } from "react";
import { AddConnector } from "../../../../components/app/add-connector";
import { AlertChannel } from "../../../../components/app/alert-channel";
import { DemoActions } from "../../../../components/app/demo-actions";
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

/** The caller's own n8n account. Never anyone else's — see the route. */
interface N8nAccount {
  state: "pending" | "invited" | "active" | "failed";
  email: string;
  inviteAcceptUrl: string | null;
  instanceId: number | null;
  failureReason: string | null;
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
  const n8n = useQuery<{ account: N8nAccount | null; n8nUrl: string | null }>(
    "/api/n8n/account",
  );

  const [busy, setBusy] = useState<number | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [revealing, setRevealing] = useState(false);
  const [revealed, setRevealed] = useState<{
    email: string;
    password: string | null;
  } | null>(null);

  /**
   * Removes an instance and the credential sealed against it.
   *
   * Confirmed by name rather than by a generic "are you sure": the page can
   * show several instances of the same connector, and the only thing that
   * distinguishes them is what someone called them.
   */
  async function disconnect(instance: { id: number; displayName: string }) {
    const ok = window.confirm(
      `Disconnect "${instance.displayName}"?\n\n` +
        "Its stored credential is destroyed and cannot be recovered — reconnecting means pasting it again. " +
        "Anything already crawled stays on the map and goes stale rather than disappearing.",
    );
    if (!ok) return;

    setBusy(instance.id);
    setNotice(null);
    try {
      await api.delete(`/api/instances/${instance.id}`);
      setNotice(`Disconnected "${instance.displayName}".`);
    } catch (err) {
      setNotice(err instanceof ApiError ? err.userMessage : "Could not disconnect it");
    } finally {
      setBusy(null);
      data.reload();
    }
  }

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

  /**
   * The pending invite for one card, if it is that card's.
   *
   * Matched on `instanceId` so a workspace with a second n8n connection — the
   * customer's own instance, say — does not show an invite that has nothing to
   * do with it. The fallback covers accounts provisioned before the connector
   * row was linked, where showing it on the only n8n card is still right.
   */
  const account = n8n.data?.account ?? null;
  const n8nUrl = n8n.data?.n8nUrl ?? null;

  async function reveal() {
    setRevealing(true);
    try {
      setRevealed(
        await api.post<{ email: string; password: string | null }>(
          "/api/n8n/account/reveal",
        ),
      );
    } catch (err) {
      setNotice(
        err instanceof ApiError ? err.userMessage : "Could not read the n8n password",
      );
    } finally {
      setRevealing(false);
    }
  }

  function inviteFor(instanceId: number): string | null {
    if (account?.state !== "invited" || !account.inviteAcceptUrl) return null;
    if (account.instanceId !== null && account.instanceId !== instanceId) return null;
    return account.inviteAcceptUrl;
  }

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

                  {instance.connector === "n8n" && (
                    <div className="ccard__extra">
                      <h4 className="ccard__sub">Demo</h4>
                      <DemoActions />
                    </div>
                  )}

                  {instance.connector === "slack" && (
                    <>
                      <div className="ccard__extra">
                        <h4 className="ccard__sub">Channels the Historian may read</h4>
                        <SlackChannels />
                      </div>
                      {/* Reading and writing are separate grants, and the
                          write one had no interface at all — so alerting was
                          off for every org that never called the API by hand. */}
                      <div className="ccard__extra">
                        <h4 className="ccard__sub">Where Sadhak posts alerts</h4>
                        <AlertChannel />
                      </div>
                    </>
                  )}

                  {/* The invite, on the card that is blocked by it.

                      n8n emails this link, except when SMTP is unconfigured —
                      which is the default and is the case here, so nothing is
                      ever delivered and the account sits unusable with no
                      indication why. Without this the connector reads as
                      broken and the only route to the link is a database
                      query. Same reasoning as the branch-protection fix
                      below: put it where the problem is visible. */}
                  {instance.connector === "n8n" && inviteFor(instance.id) && (
                    <div className="ccard__fix">
                      <p>
                        An n8n account was created for you but has no password yet. Open
                        the invite to set one, then add the API key n8n gives you.
                      </p>
                      <a
                        className="btn btn--tiny"
                        href={inviteFor(instance.id) ?? "#"}
                        target="_blank"
                        rel="noreferrer noopener"
                        data-testid="n8n-invite-link"
                      >
                        Accept n8n invite
                      </a>
                    </div>
                  )}

                  {/* The login for an account the user never chose a password
                      for. Sadhak generated it, and n8n cannot mail a reset
                      with SMTP unconfigured, so this screen is the only route
                      to it. Behind a click rather than on screen by default:
                      the page polls, and a password rendered on every load
                      ends up in more screenshots than it should. */}
                  {instance.connector === "n8n" &&
                    account?.state === "active" &&
                    account.instanceId === instance.id && (
                      <div className="ccard__extra">
                        <h4 className="ccard__sub">Your n8n sign-in</h4>
                        {/* Rendered only when the server supplied an address.
                            N8N_PUBLIC_URL is optional, and a button linking to
                            "null" is worse than no button. */}
                        {n8nUrl && (
                          <p>
                            <a
                              className="btn btn--ghost btn--tiny"
                              href={n8nUrl}
                              target="_blank"
                              rel="noreferrer noopener"
                              data-testid="n8n-dashboard-link"
                            >
                              Open n8n dashboard ↗
                            </a>
                          </p>
                        )}
                        {revealed ? (
                          <dl className="n8n-creds">
                            <dt>Email</dt>
                            <dd className="mono">{revealed.email}</dd>
                            <dt>Password</dt>
                            <dd className="mono">
                              {revealed.password ?? "You set this yourself"}
                            </dd>
                          </dl>
                        ) : (
                          <button
                            type="button"
                            className="btn btn--ghost btn--tiny"
                            disabled={revealing}
                            onClick={() => void reveal()}
                            data-testid="n8n-reveal"
                          >
                            {revealing ? "Working…" : "Show n8n password"}
                          </button>
                        )}
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
                    {/*
                      Disconnect sits apart from the other two and confirms
                      first, because the other two are safe to press and this
                      one is not: the credential is destroyed with the instance
                      and cannot be read back out of the vault to restore.

                      The graph is deliberately left alone. Nodes crawled from
                      a system that is no longer connected go stale through
                      reconciliation rather than vanishing, so a dependency
                      someone reasoned about yesterday does not disappear
                      because a token was rotated today.
                    */}
                    <span className="ccard__foot-gap" />
                    <button
                      type="button"
                      className="btn btn--ghost btn--tiny btn--danger"
                      disabled={working}
                      onClick={() => void disconnect(instance)}
                      data-testid={`connector-delete-${instance.connector}`}
                    >
                      Disconnect
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

import { connectorInstances, members, n8nAccounts, users } from "@sadhak/shared/schema";
import { and, eq } from "drizzle-orm";
import { config } from "../config.js";
import { db } from "../db.js";
import { enqueue } from "../jobs/queue.js";
import { log } from "../log.js";
import { putCredential } from "../vault/vault.js";
import { findN8nUserByEmail, inviteN8nUser, n8nAdminConfigured } from "./admin.js";
import { acceptN8nInvite, generateN8nPassword, mintApiKeyAs } from "./rest.js";

/**
 * Give a new Sadhak user an n8n account, and a connector row pointing at it.
 *
 * Runs as a job rather than inline in the signup handler. n8n being down, slow
 * or unlicensed must not be able to fail a registration — the account is the
 * thing the person came for, and the automation platform around it can arrive
 * a few seconds later.
 */

/** The connector row's name. Stable, because it is half the unique key. */
const INSTANCE_NAME = "n8n (workspace)";

export interface ProvisionResult {
  state: "invited" | "active" | "skipped" | "failed";
  n8nUserId?: string;
  instanceId?: number;
  reason?: string;
}

export async function provisionN8nAccount(userId: number): Promise<ProvisionResult> {
  if (!n8nAdminConfigured()) {
    // Not an error. A deployment without a bundled n8n is a valid deployment,
    // and the row is left `pending` so enabling n8n later and re-running the
    // job picks it up.
    return { state: "skipped", reason: "n8n admin API not configured" };
  }

  const [user] = await db
    .select({ id: users.id, email: users.email, name: users.name })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  // Signup and job run are not in the same transaction, so the user can be
  // gone by the time this executes. That is a no-op, not a failure.
  if (!user) return { state: "skipped", reason: "user no longer exists" };

  const [existing] = await db
    .select()
    .from(n8nAccounts)
    .where(eq(n8nAccounts.userId, userId))
    .limit(1);

  // Already done. The unique constraint on user_id is what actually prevents
  // duplicates; this is the cheap path that avoids a pointless upstream call.
  if (existing?.state === "active" || existing?.state === "invited") {
    return {
      state: existing.state,
      ...(existing.n8nUserId ? { n8nUserId: existing.n8nUserId } : {}),
      ...(existing.instanceId ? { instanceId: existing.instanceId } : {}),
    };
  }

  const orgId = existing?.orgId ?? (await firstOrgFor(userId));
  if (orgId === null) {
    return { state: "skipped", reason: "user has no organisation" };
  }

  try {
    const account = await inviteN8nUser(user.email);
    const instanceId = await ensureConnectorInstance(orgId);

    /**
     * Finish the job rather than handing over an invite link.
     *
     * An invite the user completes themselves produces an account we can never
     * mint a key for, because minting needs their session — so the connector
     * would sit unauthenticated until they pasted one by hand. Completing it
     * here is what makes a workspace connected the moment it is created.
     *
     * Only possible while the invite is unspent. An account already accepted
     * (a re-provision, or a user who opened the link first) keeps its own
     * password and is left as-is.
     */
    let connected = false;
    if (account.pending && account.inviterId) {
      connected = await autoConnect({
        orgId,
        instanceId,
        email: user.email,
        name: user.name,
        n8nUserId: account.id,
        inviterId: account.inviterId,
      });
    }

    const now = new Date();
    const state = connected || !account.pending ? "active" : "invited";

    await db
      .insert(n8nAccounts)
      .values({
        userId,
        orgId,
        n8nUserId: account.id,
        email: user.email,
        // Spent once we accept it ourselves, and a consumed link on screen is
        // worse than none.
        inviteAcceptUrl: connected ? null : account.inviteAcceptUrl,
        state,
        instanceId,
        invitedAt: now,
        ...(state === "active" ? { activatedAt: now } : {}),
        failureReason: null,
      })
      .onConflictDoUpdate({
        target: n8nAccounts.userId,
        set: {
          n8nUserId: account.id,
          inviteAcceptUrl: connected ? null : account.inviteAcceptUrl,
          state,
          instanceId,
          invitedAt: now,
          ...(state === "active" ? { activatedAt: now } : {}),
          failureReason: null,
          updatedAt: now,
        },
      });

    log().info(
      {
        event: "n8n_account_provisioned",
        userId,
        orgId,
        n8nUserId: account.id,
        connected,
      },
      "n8n: account provisioned",
    );

    return { state, n8nUserId: account.id, instanceId };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);

    // Recorded, then rethrown. The row is how a human sees that provisioning
    // is stuck; the rethrow is what gets the job retried with backoff. Doing
    // only one of the two either hides the failure or forgets it.
    await db
      .insert(n8nAccounts)
      .values({
        userId,
        orgId,
        email: user.email,
        state: "failed",
        failureReason: reason.slice(0, 500),
      })
      .onConflictDoUpdate({
        target: n8nAccounts.userId,
        set: {
          state: "failed",
          failureReason: reason.slice(0, 500),
          updatedAt: new Date(),
        },
      });

    throw error;
  }
}

/**
 * Accept the invite, mint that user's key, and store it against the connector.
 *
 * The key is theirs, not the platform owner's, and that is the whole point:
 * n8n scopes a member's key to their own personal project, so this connector
 * can only ever read the workflows belonging to the person who signed up.
 * Verified against the running instance — the owner key lists every workflow,
 * a freshly minted member key lists none of them.
 *
 * Returns false rather than throwing when the `/rest` calls fail. A signup
 * that produced a real n8n account but could not finish wiring it is worth
 * keeping: the account row records the account, and the connector stays in
 * `pending_auth` where a pasted key still completes it. Throwing would roll
 * the whole provision into a retry that re-invites an account that already
 * exists.
 */
async function autoConnect(input: {
  orgId: number;
  instanceId: number;
  email: string;
  name: string;
  n8nUserId: string;
  inviterId: string;
}): Promise<boolean> {
  const password = generateN8nPassword();
  const [firstName, ...rest] = input.name.trim().split(/\s+/);

  try {
    const { cookie } = await acceptN8nInvite({
      inviteeId: input.n8nUserId,
      inviterId: input.inviterId,
      email: input.email,
      firstName: firstName || "Sadhak",
      // n8n rejects an empty last name.
      lastName: rest.join(" ") || "User",
      password,
    });

    const apiKey = await mintApiKeyAs(cookie);

    await putCredential({
      orgId: input.orgId,
      instanceId: input.instanceId,
      scope: "read",
      kind: "api_key",
      value: apiKey,
    });

    /**
     * The login, kept so the user can actually get into n8n.
     *
     * They never chose this password and n8n cannot mail them a reset — SMTP
     * is unconfigured, which is the reason this whole path exists — so if we
     * do not keep it, we have created an account nobody can sign into. It is
     * sealed by the same vault as every other secret, and `NON_AUTH_KINDS`
     * keeps the crawler from ever picking it up as a bearer token.
     */
    await putCredential({
      orgId: input.orgId,
      instanceId: input.instanceId,
      scope: "read",
      kind: "n8n_user_password",
      value: password,
    });

    await db
      .update(connectorInstances)
      .set({
        status: "active",
        statusDetail: null,
        lastCrawlError: null,
        consecutiveFailures: 0,
        breakerOpenUntil: null,
        updatedAt: new Date(),
      })
      .where(eq(connectorInstances.id, input.instanceId));

    // Now that it is authenticated there is something to read. Both are
    // deduped, so an already-armed org is not double-scheduled.
    await enqueue(
      "connector.crawl",
      { instanceId: input.instanceId, kind: "full" },
      { orgId: input.orgId, dedupeKey: `connector.crawl:${input.instanceId}` },
    );
    await enqueue(
      "n8n.poll_executions",
      {},
      { orgId: input.orgId, dedupeKey: `n8n.poll_executions:${input.orgId}` },
    );

    return true;
  } catch (error) {
    log().warn(
      {
        event: "n8n_auto_connect_failed",
        orgId: input.orgId,
        instanceId: input.instanceId,
        err: error instanceof Error ? error.message : String(error),
      },
      "n8n: account created but auto-connect failed; a pasted key still completes it",
    );
    return false;
  }
}

async function firstOrgFor(userId: number): Promise<number | null> {
  const [row] = await db
    .select({ orgId: members.orgId })
    .from(members)
    .where(eq(members.userId, userId))
    .limit(1);
  return row?.orgId ?? null;
}

/**
 * The org's n8n connector, created in `pending_auth` and left there.
 *
 * The platform's owner API key is deliberately *not* written into this
 * instance's credential. That key is unscoped: on a community licence
 * `/api/v1/projects` is 403 and there is no way to constrain a request to one
 * user's personal project, so an org crawling with the owner key would pull
 * every other tenant's workflows into its graph. Sharing one key across
 * tenants is a cross-tenant read, not a shortcut.
 *
 * So the row is provisioned pointing at the right instance with the right
 * name, and waits for the user's own API key — which they mint from their own
 * n8n account, and which n8n scopes to their own workflows for us. Until then
 * `getReadCredential` returns nothing and every poll cleanly skips it.
 */
async function ensureConnectorInstance(orgId: number): Promise<number> {
  const [existing] = await db
    .select({ id: connectorInstances.id })
    .from(connectorInstances)
    .where(
      and(
        eq(connectorInstances.orgId, orgId),
        eq(connectorInstances.connector, "n8n"),
        eq(connectorInstances.displayName, INSTANCE_NAME),
      ),
    )
    .limit(1);

  if (existing) return existing.id;

  const [created] = await db
    .insert(connectorInstances)
    .values({
      orgId,
      connector: "n8n",
      displayName: INSTANCE_NAME,
      config: { baseUrl: config.N8N_BASE_URL ?? "" },
      status: "pending_auth",
      statusDetail:
        "Accept the n8n invite, then add an API key from n8n's Settings → API screen.",
    })
    .returning({ id: connectorInstances.id });

  if (!created) throw new Error(`failed to create n8n connector instance for ${orgId}`);
  return created.id;
}

/**
 * Reconcile an invited account that the user has since accepted.
 *
 * n8n never tells us this happened, so it is observed rather than received:
 * the account stops being `isPending` upstream. Cheap enough to fold into the
 * poll, and it is what makes `active` mean something.
 */
export async function refreshAccountState(userId: number): Promise<void> {
  if (!n8nAdminConfigured()) return;

  const [account] = await db
    .select()
    .from(n8nAccounts)
    .where(and(eq(n8nAccounts.userId, userId), eq(n8nAccounts.state, "invited")))
    .limit(1);

  if (!account) return;

  const upstream = await findN8nUserByEmail(account.email);
  if (!upstream || upstream.pending) return;

  await db
    .update(n8nAccounts)
    .set({
      state: "active",
      activatedAt: new Date(),
      updatedAt: new Date(),
      // Spent. Keeping a consumed invite link around invites confusion.
      inviteAcceptUrl: null,
    })
    .where(eq(n8nAccounts.id, account.id));
}

export async function orgIdForUser(userId: number): Promise<number | null> {
  return firstOrgFor(userId);
}

export const __testing = { INSTANCE_NAME };

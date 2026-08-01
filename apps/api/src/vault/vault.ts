import { connectorCredentials } from "@sadhak/shared/schema";
import { and, eq, notInArray } from "drizzle-orm";
import { auditSystem } from "../audit.js";
import { db } from "../db.js";
import { SystemError } from "../errors.js";
import { credentialAad, getKeyring } from "./keyring.js";
import { Secret } from "./secret.js";

/**
 * The only module that reads or writes credential material. Every read writes
 * an audit event naming the row and the caller — never the value — because
 * that is the query a breach postmortem needs.
 */

export type CredentialScope = "read" | "write";

export interface PutCredentialInput {
  orgId: number;
  instanceId: number;
  scope: CredentialScope;
  kind: string;
  value: string;
  createdBy?: number | null;
  expiresAt?: Date | null;
}

export interface CredentialSummary {
  id: number;
  scope: CredentialScope;
  kind: string;
  fingerprint: string;
  createdAt: Date;
  expiresAt: Date | null;
}

export function vaultAvailable(): boolean {
  return getKeyring() !== null;
}

export async function putCredential(
  input: PutCredentialInput,
): Promise<CredentialSummary> {
  const keyring = getKeyring();
  if (!keyring) {
    throw new SystemError("CREDENTIAL_MASTER_KEY is not configured");
  }

  const secret = new Secret(input.value);
  const aad = credentialAad(input.orgId, input.instanceId, input.scope, input.kind);
  const { keyId, sealed } = keyring.seal(Buffer.from(secret.reveal(), "utf8"), aad);

  const [row] = await db
    .insert(connectorCredentials)
    .values({
      orgId: input.orgId,
      instanceId: input.instanceId,
      scope: input.scope,
      kind: input.kind,
      keyId,
      sealed: sealed.toString("base64"),
      fingerprint: secret.fingerprint(),
      createdBy: input.createdBy ?? null,
      expiresAt: input.expiresAt ?? null,
    })
    .onConflictDoUpdate({
      target: [
        connectorCredentials.instanceId,
        connectorCredentials.scope,
        connectorCredentials.kind,
      ],
      set: {
        keyId,
        sealed: sealed.toString("base64"),
        fingerprint: secret.fingerprint(),
        rotatedAt: new Date(),
        expiresAt: input.expiresAt ?? null,
      },
    })
    .returning({
      id: connectorCredentials.id,
      createdAt: connectorCredentials.createdAt,
    });

  return {
    id: row?.id ?? 0,
    scope: input.scope,
    kind: input.kind,
    fingerprint: secret.fingerprint(),
    createdAt: row?.createdAt ?? new Date(),
    expiresAt: input.expiresAt ?? null,
  };
}

export async function getCredential(
  orgId: number,
  instanceId: number,
  scope: CredentialScope,
  kind: string,
  caller: string,
): Promise<Secret | null> {
  const keyring = getKeyring();
  if (!keyring) return null;

  const [row] = await db
    .select()
    .from(connectorCredentials)
    .where(
      and(
        eq(connectorCredentials.orgId, orgId),
        eq(connectorCredentials.instanceId, instanceId),
        eq(connectorCredentials.scope, scope),
        eq(connectorCredentials.kind, kind),
      ),
    )
    .limit(1);

  if (!row) return null;

  const plaintext = keyring.open(
    row.keyId,
    Buffer.from(row.sealed, "base64"),
    credentialAad(orgId, instanceId, scope, kind),
  );

  await auditSystem(
    "credential.decrypted",
    orgId,
    {
      kind: "connector_credential",
      id: row.id,
    },
    { caller, scope, credentialKind: kind },
  );

  return new Secret(plaintext.toString("utf8"));
}

/**
 * Kinds stored at `read` scope that are NOT provider credentials.
 *
 * Reflex keeps the Airtable webhook MAC secret and the n8n hook secret on the
 * same instance and the same scope as the API key. They are secrets we verify
 * *incoming* signatures with, never something to authenticate outbound with.
 */
const NON_AUTH_KINDS: string[] = ["webhook_secret", "hook_secret"];

/**
 * Preferred order when an instance legitimately holds more than one way to
 * authenticate. Slack is the live case: the bot token is the general-purpose
 * one, so it wins over the user token unless a caller asks for a specific kind.
 */
const AUTH_KIND_PRECEDENCE: readonly string[] = [
  "api_key",
  "connection_string",
  "token",
  "oauth_access",
  "oauth_user_access",
];

/**
 * The instance's authentication credential.
 *
 * This used to be `LIMIT 1` with no ORDER BY over every read-scope row, which
 * is only correct while an instance has exactly one. It does not: registering
 * an Airtable webhook adds a second, and Slack's OAuth adds two. Postgres is
 * free to return either, and which one it returns can change when an unrelated
 * row is rewritten — so re-pasting a valid PAT could start authenticating to
 * Airtable with an HMAC secret, and the resulting 401 is reported as "Airtable
 * rejected the credential" while pointing at a token that is perfectly fine.
 *
 * Non-auth kinds are excluded rather than ranked last: handing a webhook
 * secret to a provider is never the right answer, so no ordering accident can
 * reach it. Callers that want one specific kind use `getCredential`.
 */
export async function getReadCredential(
  orgId: number,
  instanceId: number,
  caller: string,
): Promise<Secret | null> {
  const rows = await db
    .select({ kind: connectorCredentials.kind })
    .from(connectorCredentials)
    .where(
      and(
        eq(connectorCredentials.orgId, orgId),
        eq(connectorCredentials.instanceId, instanceId),
        eq(connectorCredentials.scope, "read"),
        notInArray(connectorCredentials.kind, NON_AUTH_KINDS),
      ),
    );

  // Sorted here rather than in SQL: the precedence is a product rule about
  // which token is more capable, not something a column ordering expresses.
  // The kind tie-break keeps an unrecognised kind deterministic instead of
  // heap-ordered.
  const kinds = rows.map((row) => row.kind).sort(byAuthPrecedence);

  const kind = kinds[0];
  if (!kind) return null;
  return getCredential(orgId, instanceId, "read", kind, caller);
}

function byAuthPrecedence(a: string, b: string): number {
  const rankA = AUTH_KIND_PRECEDENCE.indexOf(a);
  const rankB = AUTH_KIND_PRECEDENCE.indexOf(b);
  const safeA = rankA === -1 ? AUTH_KIND_PRECEDENCE.length : rankA;
  const safeB = rankB === -1 ? AUTH_KIND_PRECEDENCE.length : rankB;
  return safeA === safeB ? a.localeCompare(b) : safeA - safeB;
}

export async function listCredentials(
  orgId: number,
  instanceId: number,
): Promise<CredentialSummary[]> {
  const rows = await db
    .select({
      id: connectorCredentials.id,
      scope: connectorCredentials.scope,
      kind: connectorCredentials.kind,
      fingerprint: connectorCredentials.fingerprint,
      createdAt: connectorCredentials.createdAt,
      expiresAt: connectorCredentials.expiresAt,
    })
    .from(connectorCredentials)
    .where(
      and(
        eq(connectorCredentials.orgId, orgId),
        eq(connectorCredentials.instanceId, instanceId),
      ),
    );
  return rows;
}

export async function deleteCredential(
  orgId: number,
  instanceId: number,
  scope: CredentialScope,
  kind: string,
): Promise<boolean> {
  const deleted = await db
    .delete(connectorCredentials)
    .where(
      and(
        eq(connectorCredentials.orgId, orgId),
        eq(connectorCredentials.instanceId, instanceId),
        eq(connectorCredentials.scope, scope),
        eq(connectorCredentials.kind, kind),
      ),
    )
    .returning({ id: connectorCredentials.id });
  return deleted.length > 0;
}

import { connectorCredentials } from "@sadhak/shared/schema";
import { and, eq } from "drizzle-orm";
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

/** Any read credential on the instance — crawlers do not care which kind. */
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
      ),
    )
    .limit(1);

  const kind = rows[0]?.kind;
  if (!kind) return null;
  return getCredential(orgId, instanceId, "read", kind, caller);
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

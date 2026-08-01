import { createHash, randomBytes } from "node:crypto";
import { type Capability, isCapability } from "@sadhak/shared/rbac";
import { apiKeys } from "@sadhak/shared/schema";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "../db.js";

/**
 * The Mode 2 credential: an AI agent holding a Sadhak key must be able to
 * invoke the gate and nothing else, and a leaked backup must not leak usable
 * keys. Hashed at rest, full value shown exactly once.
 */

export const KEY_PREFIX = "sadhak_";

export function hashKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

export interface CreatedKey {
  id: number;
  name: string;
  /** The only time the full key exists outside the caller's hands. */
  key: string;
  prefix: string;
  scopes: Capability[];
}

export async function createApiKey(input: {
  orgId: number;
  name: string;
  scopes: Capability[];
  createdBy: number;
}): Promise<CreatedKey> {
  const key = `${KEY_PREFIX}${randomBytes(24).toString("base64url")}`;
  const prefix = `${key.slice(0, KEY_PREFIX.length + 6)}…`;

  const [row] = await db
    .insert(apiKeys)
    .values({
      orgId: input.orgId,
      name: input.name,
      keyHash: hashKey(key),
      prefix,
      scopes: input.scopes,
      createdBy: input.createdBy,
    })
    .returning({ id: apiKeys.id });

  return { id: row?.id ?? 0, name: input.name, key, prefix, scopes: input.scopes };
}

export interface KeyActor {
  keyId: number;
  orgId: number;
  scopes: Capability[];
}

/** Org comes from the key, never from request input. */
export async function verifyApiKey(key: string): Promise<KeyActor | null> {
  if (!key.startsWith(KEY_PREFIX)) return null;

  const [row] = await db
    .select({
      id: apiKeys.id,
      orgId: apiKeys.orgId,
      scopes: apiKeys.scopes,
    })
    .from(apiKeys)
    .where(and(eq(apiKeys.keyHash, hashKey(key)), isNull(apiKeys.revokedAt)))
    .limit(1);

  if (!row) return null;

  await db.update(apiKeys).set({ lastUsedAt: new Date() }).where(eq(apiKeys.id, row.id));

  return {
    keyId: row.id,
    orgId: row.orgId,
    scopes: (row.scopes ?? []).filter(isCapability),
  };
}

export async function listApiKeys(orgId: number) {
  return db
    .select({
      id: apiKeys.id,
      name: apiKeys.name,
      prefix: apiKeys.prefix,
      scopes: apiKeys.scopes,
      lastUsedAt: apiKeys.lastUsedAt,
      revokedAt: apiKeys.revokedAt,
      createdAt: apiKeys.createdAt,
    })
    .from(apiKeys)
    .where(eq(apiKeys.orgId, orgId))
    .orderBy(apiKeys.createdAt);
}

export async function revokeApiKey(orgId: number, keyId: number): Promise<boolean> {
  const revoked = await db
    .update(apiKeys)
    .set({ revokedAt: new Date() })
    .where(
      and(eq(apiKeys.id, keyId), eq(apiKeys.orgId, orgId), isNull(apiKeys.revokedAt)),
    )
    .returning({ id: apiKeys.id });
  return revoked.length > 0;
}

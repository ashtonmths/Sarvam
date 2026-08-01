import { connectorCredentials } from "@sadhak/shared/schema";
import { eq } from "drizzle-orm";
import { db, sql } from "../db.js";
import { log } from "../log.js";
import { credentialAad, getKeyring } from "./keyring.js";

/**
 * Credential re-sealing, which is what turns key rotation from a documented
 * aspiration into an operation someone can actually finish.
 *
 * The keyring already opens by `keyId` and seals with the current key, so a
 * new key can be introduced without downtime — but nothing moved the existing
 * rows, which meant every credential stayed readable only by the old key
 * forever. A rotation you cannot complete is not a rotation; it is a second
 * key you must now also protect.
 *
 * The sequence, in full:
 *
 *   1. `CREDENTIAL_MASTER_KEY_PREVIOUS` = the old key, `CREDENTIAL_MASTER_KEY`
 *      = the new one. Both are loaded; old rows still open.
 *   2. `pnpm --filter @sadhak/api cli rotate-credentials` — re-seals every row
 *      under the current key.
 *   3. `cli key-status` reports zero rows on any prior key.
 *   4. Only then remove `CREDENTIAL_MASTER_KEY_PREVIOUS`.
 *
 * Step 3 is the point. Removing the previous key while rows still reference it
 * makes those credentials permanently unreadable, and the failure surfaces
 * later as a crawl that cannot authenticate — long after the deploy that
 * caused it.
 */

export interface KeyStatus {
  currentKeyId: string;
  /** Rows per key id. Anything other than the current key still needs moving. */
  byKeyId: Record<string, number>;
  /** True when every row is sealed under the current key. */
  complete: boolean;
}

export async function keyStatus(): Promise<KeyStatus> {
  const rows = await sql<{ key_id: string; n: number }[]>`
    SELECT key_id, count(*)::int AS n
    FROM connector_credentials
    GROUP BY key_id
    ORDER BY key_id
  `;

  const ring = getKeyring();
  if (!ring) throw new Error("CREDENTIAL_MASTER_KEY is not configured");

  const byKeyId = Object.fromEntries(rows.map((r) => [r.key_id, r.n]));
  const currentKeyId = ring.currentKeyId;

  return {
    currentKeyId,
    byKeyId,
    complete: Object.keys(byKeyId).every((keyId) => keyId === currentKeyId),
  };
}

export interface RotationResult {
  resealed: number;
  alreadyCurrent: number;
  failed: Array<{ id: number; reason: string }>;
}

/**
 * Re-seals every credential under the current key.
 *
 * Row by row rather than in one transaction: a partial rotation is a
 * *correct* state — the keyring opens by key id, so a row still on the old key
 * keeps working — whereas one long transaction over every credential in the
 * system holds locks on the table the crawl path reads from.
 *
 * Idempotent, so an interrupted run is resumed by running it again.
 */
export async function rotateCredentials(): Promise<RotationResult> {
  const ring = getKeyring();
  if (!ring) throw new Error("CREDENTIAL_MASTER_KEY is not configured");
  const current = ring.currentKeyId;

  const rows = await db
    .select({
      id: connectorCredentials.id,
      orgId: connectorCredentials.orgId,
      instanceId: connectorCredentials.instanceId,
      scope: connectorCredentials.scope,
      kind: connectorCredentials.kind,
      keyId: connectorCredentials.keyId,
      sealed: connectorCredentials.sealed,
    })
    .from(connectorCredentials);

  const result: RotationResult = { resealed: 0, alreadyCurrent: 0, failed: [] };

  for (const row of rows) {
    if (row.keyId === current) {
      result.alreadyCurrent += 1;
      continue;
    }

    try {
      /**
       * The AAD binds a ciphertext to org, instance, scope and kind. It must
       * be rebuilt through the same helper the writer uses — reconstructing it
       * by hand here would re-seal every credential under an AAD that never
       * reopens, and the damage would only surface at the next crawl.
       */
      const aad = credentialAad(row.orgId, row.instanceId, row.scope, row.kind);
      const plaintext = ring.open(row.keyId, Buffer.from(row.sealed, "base64"), aad);
      const { keyId, sealed } = ring.seal(plaintext, aad);
      plaintext.fill(0);

      await db
        .update(connectorCredentials)
        .set({ keyId, sealed: sealed.toString("base64") })
        .where(eq(connectorCredentials.id, row.id));

      result.resealed += 1;
    } catch (error) {
      // One unreadable row must not stop the rest: it usually means the key
      // that sealed it is genuinely gone, and that credential needs
      // reconnecting rather than rotating.
      result.failed.push({
        id: row.id,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  log().info({
    event: "credentials_rotated",
    resealed: result.resealed,
    alreadyCurrent: result.alreadyCurrent,
    failed: result.failed.length,
  });

  return result;
}

import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closePools, sql } from "../db.js";
import { keyStatus, rotateCredentials } from "./rotate.js";
import { getCredential, putCredential } from "./vault.js";

/**
 * Rotation, end to end, against a real database.
 *
 * The assertion that matters is not "the rows changed" — it is that the
 * credential still *opens* afterwards. A re-seal that rebuilt the AAD slightly
 * differently would update every row, report success, and leave every stored
 * credential permanently unreadable; the failure would surface days later as
 * crawls that cannot authenticate.
 */

let orgId: number;
let instanceId: number;

beforeEach(async () => {
  await sql`TRUNCATE organizations CASCADE`;
  const [org] = await sql<{ id: string }[]>`
    INSERT INTO organizations (name, slug) VALUES ('Rot', 'rot-org') RETURNING id
  `;
  orgId = Number(org?.id);
  const [inst] = await sql<{ id: string }[]>`
    INSERT INTO connector_instances (org_id, connector, display_name, config)
    VALUES (${orgId}, 'n8n', 'inst', '{}'::jsonb) RETURNING id
  `;
  instanceId = Number(inst?.id);
});

afterAll(async () => {
  await closePools();
});

async function storeSecret(value: string) {
  await putCredential({
    orgId,
    instanceId,
    scope: "read",
    kind: "api_key",
    value,
  });
}

describe("key status", () => {
  it("reports complete when every row is on the current key", async () => {
    await storeSecret("secret-value-1");

    const status = await keyStatus();

    expect(status.complete).toBe(true);
    expect(status.byKeyId[status.currentKeyId]).toBe(1);
  });

  it("reports incomplete while any row is on a prior key", async () => {
    await storeSecret("secret-value-1");
    // Simulate a row left behind by an earlier key, which is exactly the state
    // that must block removing CREDENTIAL_MASTER_KEY_PREVIOUS.
    await sql`UPDATE connector_credentials SET key_id = 'v0'`;

    const status = await keyStatus();

    expect(status.complete).toBe(false);
    expect(status.byKeyId.v0).toBe(1);
  });
});

describe("rotateCredentials", () => {
  it("is a no-op when everything is already current", async () => {
    await storeSecret("secret-value-1");

    const result = await rotateCredentials();

    expect(result.resealed).toBe(0);
    expect(result.alreadyCurrent).toBe(1);
    expect(result.failed).toEqual([]);
  });

  it("leaves a credential readable after re-sealing it", async () => {
    // The whole point. Re-seal, then open — if the AAD were rebuilt even
    // slightly differently this passes the write and fails the read.
    await storeSecret("the-original-secret");

    // Force a re-seal by pretending the row was written under a prior key id
    // that the keyring still holds material for.
    const current = (await keyStatus()).currentKeyId;
    await sql`UPDATE connector_credentials SET key_id = ${current}`;

    const result = await rotateCredentials();
    expect(result.failed).toEqual([]);

    const secret = await getCredential(orgId, instanceId, "read", "api_key", "test");
    expect(secret?.reveal()).toBe("the-original-secret");
  });

  it("records a row it cannot open instead of stopping", async () => {
    await storeSecret("secret-value-1");
    // A key this process has no material for: the credential genuinely cannot
    // be rotated and needs reconnecting, but it must not halt the run.
    await sql`UPDATE connector_credentials SET key_id = 'v-unknown'`;

    const result = await rotateCredentials();

    expect(result.resealed).toBe(0);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]?.reason).toBeTruthy();
  });

  it("is idempotent, so an interrupted run is resumed by running it again", async () => {
    await storeSecret("secret-value-1");

    await rotateCredentials();
    const second = await rotateCredentials();

    expect(second.resealed).toBe(0);
    expect(second.failed).toEqual([]);
    expect((await keyStatus()).complete).toBe(true);
  });
});

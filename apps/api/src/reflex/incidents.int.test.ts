import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closePools, sql } from "../db.js";
import {
  claimForRevert,
  markAcknowledged,
  markAlerted,
  markReverted,
  markRevertFailed,
  recordDetection,
  recordVerdict,
} from "./incidents.js";

/**
 * The Reflex incident lifecycle against a real Postgres.
 *
 * Every transition here is a conditional UPDATE, and the property that matters
 * is that concurrent callers cannot both win. Reflex is the only subsystem
 * that writes to a customer's systems, and the revert button lives in Slack
 * where two people see the same alert — so "two clicks race safely" is not a
 * nicety, it is the difference between restoring a field once and mutating a
 * customer's base twice.
 */

let orgId: number;

beforeEach(async () => {
  await sql`TRUNCATE organizations CASCADE`;
  const [org] = await sql<{ id: string }[]>`
    INSERT INTO organizations (name, slug) VALUES ('Reflex Org', 'reflex-org')
    RETURNING id
  `;
  orgId = Number(org?.id);
});

afterAll(async () => {
  await closePools();
});

function change(overrides: Record<string, unknown> = {}) {
  return {
    orgId,
    connector: "airtable",
    change: {
      target: "field" as const,
      operation: "delete" as const,
      connector: "airtable" as const,
      externalId: "app1/tbl1/fld1",
    },
    vendorEventId: "evt-1",
    changeAt: new Date(),
    detectPath: "push" as const,
    ...overrides,
  };
}

describe("recordDetection", () => {
  it("records a new incident and returns its id", async () => {
    const id = await recordDetection(change());

    expect(id).not.toBeNull();
  });

  it("returns null for a redelivery instead of creating a second incident", async () => {
    // Providers retry, and so do our own jobs. At-least-once delivery has to
    // collapse to exactly one incident or the operator is paged twice for one
    // deletion and stops trusting the alerts.
    const first = await recordDetection(change());
    const second = await recordDetection(change());

    expect(first).not.toBeNull();
    expect(second).toBeNull();

    const rows = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM reflex_incidents
    `;
    expect(rows[0]?.n).toBe(1);
  });

  it("treats a different vendor event as a different incident", async () => {
    await recordDetection(change());
    const second = await recordDetection(change({ vendorEventId: "evt-2" }));

    expect(second).not.toBeNull();
  });

  it("survives concurrent delivery of the same event", async () => {
    const results = await Promise.all([
      recordDetection(change()),
      recordDetection(change()),
      recordDetection(change()),
    ]);

    expect(results.filter((id) => id !== null)).toHaveLength(1);
  });
});

describe("the revert claim", () => {
  it("is won by exactly one of two concurrent clicks", async () => {
    const id = (await recordDetection(change())) as number;

    const [a, b] = await Promise.all([
      claimForRevert(id, "alice"),
      claimForRevert(id, "bob"),
    ]);

    expect([a, b].filter(Boolean)).toHaveLength(1);
  });

  it("records only the winner as the requester", async () => {
    const id = (await recordDetection(change())) as number;

    await claimForRevert(id, "alice");
    await claimForRevert(id, "bob");

    const rows = await sql<{ revert_requested_by: string }[]>`
      SELECT revert_requested_by FROM reflex_incidents WHERE id = ${id}
    `;
    expect(rows[0]?.revert_requested_by).toBe("alice");
  });

  it("cannot be claimed again once the revert already succeeded", async () => {
    const id = (await recordDetection(change())) as number;
    await claimForRevert(id, "alice");
    await markReverted(id);

    // A late click on a stale Slack message must not mutate the base again.
    expect(await claimForRevert(id, "bob")).toBe(false);
  });

  it("can be reclaimed after a failure, so the retry button works", async () => {
    const id = (await recordDetection(change())) as number;
    await claimForRevert(id, "alice");
    await markRevertFailed(id, "airtable rejected the write");

    expect(await claimForRevert(id, "alice")).toBe(true);
  });
});

describe("state transitions", () => {
  it("refuses to mark reverted from a state that never claimed", async () => {
    const id = (await recordDetection(change())) as number;

    expect(await markReverted(id)).toBe(false);
  });

  it("writes each timestamp once, so a retry cannot move it", async () => {
    const id = (await recordDetection(change())) as number;
    await markAlerted(id, "C123", "1700000000.1");

    const first = await sql<{ alerted_at: Date }[]>`
      SELECT alerted_at FROM reflex_incidents WHERE id = ${id}
    `;

    // A redelivered alert job re-runs the same transition. COALESCE keeps the
    // original timestamp, which is what MTTD is measured from.
    await sql`UPDATE reflex_incidents SET state = 'detected' WHERE id = ${id}`;
    await markAlerted(id, "C123", "1700000000.1");

    const second = await sql<{ alerted_at: Date }[]>`
      SELECT alerted_at FROM reflex_incidents WHERE id = ${id}
    `;
    expect(second[0]?.alerted_at).toEqual(first[0]?.alerted_at);
  });

  it("acknowledges from detected or alerted, but not from reverted", async () => {
    const id = (await recordDetection(change())) as number;
    expect(await markAcknowledged(id, "alice", true)).toBe(true);

    const other = (await recordDetection(change({ vendorEventId: "evt-9" }))) as number;
    await claimForRevert(other, "alice");
    await markReverted(other);
    expect(await markAcknowledged(other, "bob", true)).toBe(false);
  });
});

/** verdict_id is a real foreign key, so the row has to exist. */
async function insertVerdict(verdict: string): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO verdicts (org_id, change, verdict)
    VALUES (${orgId}, ${JSON.stringify({ target: "field" })}::jsonb, ${verdict})
    RETURNING id
  `;
  if (!row) throw new Error("failed to insert verdict");
  return row.id;
}

describe("recordVerdict", () => {
  it("is applied once, so a retried job does not overwrite the first verdict", async () => {
    const id = (await recordDetection(change())) as number;
    const blockId = await insertVerdict("BLOCK");
    const approveId = await insertVerdict("APPROVE");

    expect(await recordVerdict(id, blockId, "BLOCK", [], [])).toBe(true);
    expect(await recordVerdict(id, approveId, "APPROVE", [], [])).toBe(false);

    const rows = await sql<{ verdict: string }[]>`
      SELECT verdict FROM reflex_incidents WHERE id = ${id}
    `;
    expect(rows[0]?.verdict).toBe("BLOCK");
  });
});

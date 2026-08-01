import { createHash } from "node:crypto";
import {
  connectorInstances,
  nodes as nodesTable,
  structureSnapshots,
} from "@sadhak/shared/schema";
import type { ChangeDescriptor } from "@sadhak/shared/types";
import { and, desc, eq } from "drizzle-orm";
import { baseUrlFor, egressOptionsFor } from "../connectors/registry.js";
import { db } from "../db.js";
import { enqueue } from "../jobs/queue.js";
import { pinnedFetch } from "../net/pinned-fetch.js";
import { getReadCredential } from "../vault/vault.js";
import { recordDetection } from "./incidents.js";

/**
 * n8n has no outbound "workflow changed" webhook in its public API, so there
 * are two honest paths: a push hook for instances whose deployment we or the
 * customer control, and polling for API-key-only access.
 *
 * This is the poll path. It is interval-bound, and every incident it creates
 * is flagged `detect_path='poll'` — push and poll latencies must never be
 * blended into one headline number.
 */

const POLL_LIMIT = 100;

/** Bounded so one enormous instance cannot hold the poll indefinitely. */
const MAX_POLL_PAGES = 20;

interface N8nWorkflow extends Record<string, unknown> {
  id: string;
  name: string;
  active?: boolean;
  updatedAt?: string;
  versionId?: string;
  nodes?: unknown[];
  connections?: Record<string, unknown>;
}

function hashStructure(workflow: N8nWorkflow): string {
  // Structure only. n8n's `pinData` carries sampled payloads and is stripped
  // before anything is hashed or stored.
  const structural = {
    name: workflow.name,
    active: workflow.active ?? false,
    nodes: workflow.nodes ?? [],
    connections: workflow.connections ?? {},
  };
  return createHash("sha256").update(JSON.stringify(structural)).digest("hex");
}

/**
 * A vendor timestamp that cannot be trusted to parse.
 *
 * `new Date("garbage")` yields Invalid Date, which drizzle serialises by
 * calling `toISOString()` — that throws a RangeError, and the throw escapes
 * the poll before its re-enqueue, so one malformed `updatedAt` dead-lettered
 * the job and stopped n8n change detection for that org permanently.
 *
 * A zone-less string is also read in the process's local zone by V8, so it is
 * rejected rather than silently offset by however the container is configured.
 */
function parseVendorDate(raw: string | undefined): Date | null {
  if (!raw) return null;
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return null;
  // Requires an explicit zone: trailing Z, or +hh:mm / -hh:mm.
  if (!/(?:Z|[+-]\d{2}:?\d{2})$/.test(raw.trim())) return null;
  return parsed;
}

function stripPayloads(workflow: N8nWorkflow): Record<string, unknown> {
  const rest: Record<string, unknown> = { ...workflow };
  delete rest.pinData;
  delete rest.staticData;
  return rest;
}

export async function pollN8nWorkflows(orgId: number): Promise<number> {
  const instances = await db
    .select()
    .from(connectorInstances)
    .where(
      and(
        eq(connectorInstances.orgId, orgId),
        eq(connectorInstances.connector, "n8n"),
        eq(connectorInstances.status, "active"),
      ),
    );

  let detected = 0;

  for (const instance of instances) {
    const secret = await getReadCredential(orgId, instance.id, "reflex.poll_n8n");
    if (!secret) continue;

    /**
     * Paged to the end rather than taking the first hundred.
     *
     * A single `limit=100` call left every workflow past the hundredth
     * unmonitored — silently, since nothing compared what was asked for
     * against what came back. `complete` also matters below: deletion is
     * inferred from absence, and absence is only meaningful if the whole list
     * was actually read.
     */
    const workflows: N8nWorkflow[] = [];
    let complete = false;
    try {
      let cursor: string | undefined;
      for (let page = 0; page < MAX_POLL_PAGES; page += 1) {
        const url = new URL(`${baseUrlFor(instance)}/api/v1/workflows`);
        url.searchParams.set("limit", String(POLL_LIMIT));
        if (cursor) url.searchParams.set("cursor", cursor);

        const res = await pinnedFetch(
          url.toString(),
          {
            headers: { "X-N8N-API-KEY": secret.reveal(), accept: "application/json" },
          },
          egressOptionsFor(instance),
        );
        if (!res.ok) break;

        const body = (await res.json()) as { data?: N8nWorkflow[]; nextCursor?: string };
        workflows.push(...(body.data ?? []));

        cursor = body.nextCursor ?? undefined;
        if (!cursor) {
          complete = true;
          break;
        }
      }
    } catch {
      continue;
    }

    for (const workflow of workflows) {
      const externalId = `workflow/${workflow.id}`;
      const hash = hashStructure(workflow);

      const [latest] = await db
        .select()
        .from(structureSnapshots)
        .where(
          and(
            eq(structureSnapshots.orgId, orgId),
            eq(structureSnapshots.connector, "n8n"),
            eq(structureSnapshots.externalId, externalId),
          ),
        )
        .orderBy(desc(structureSnapshots.capturedAt))
        .limit(1);

      // Hash-gated: an unchanged poll writes nothing.
      if (latest?.contentHash === hash) continue;

      await db
        .insert(structureSnapshots)
        .values({
          orgId,
          connector: "n8n",
          externalId,
          contentHash: hash,
          structure: stripPayloads(workflow),
        })
        .onConflictDoNothing();

      // The first sighting is a baseline, not a change.
      if (!latest) continue;

      const previous = latest.structure as unknown as N8nWorkflow;
      const operation = deriveOperation(previous, workflow);

      const change: ChangeDescriptor = {
        target: "workflow",
        operation,
        connector: "n8n",
        externalId,
      };

      const [node] = await db
        .select({ id: nodesTable.id })
        .from(nodesTable)
        .where(
          and(
            eq(nodesTable.orgId, orgId),
            eq(nodesTable.connector, "n8n"),
            eq(nodesTable.externalId, externalId),
          ),
        )
        .limit(1);

      const incidentId = await recordDetection({
        orgId,
        connector: "n8n",
        change,
        /**
         * The *previous* structure plus this one, not this one alone.
         *
         * Keying on the new hash made the dedupe key a function of a state
         * rather than of a transition, so any change that reproduced a
         * structure seen before was silently swallowed: disable a workflow,
         * re-enable it, disable it again a fortnight later, and the second
         * disable produced the identical key and no incident at all. Reflex
         * went permanently blind to every repeat of a change it had seen
         * once — and repeats are exactly what an incident review looks for.
         *
         * The pair is unique per transition, so a genuine redelivery still
         * collapses while a real recurrence does not.
         */
        vendorEventId: `${(latest.contentHash ?? "").slice(0, 16)}:${hash.slice(0, 16)}`,
        changeAt: parseVendorDate(workflow.updatedAt),
        detectPath: "poll",
        nodeId: node?.id ?? null,
      });

      if (incidentId === null) continue;
      detected += 1;

      // Deactivation is reflected on the node so the graph is honest between
      // crawls.
      if (operation === "disable" && node) {
        await db
          .update(nodesTable)
          .set({ metadata: { ...stripPayloads(workflow), active: false } })
          .where(eq(nodesTable.id, node.id));
      }

      await enqueue(
        "reflex.verdict",
        { incidentId },
        { orgId, dedupeKey: `reflex.verdict:${incidentId}`, priority: 5 },
      );
    }

    /**
     * Deletion, which the loop above can never see.
     *
     * It iterates the workflows the API *returned*, so a workflow that no
     * longer exists produces no comparison and no incident — leaving Reflex
     * blind to the single most destructive change it claims to cover. Absence
     * is the only signal available, so it is inferred by diffing what we have
     * snapshots for against what came back.
     *
     * Only when the listing was complete. A truncated page or a mid-poll
     * failure would otherwise read as "everything vanished" and raise an
     * incident per workflow, which is a worse failure than missing one.
     */
    if (!complete) continue;

    const present = new Set(workflows.map((w) => `workflow/${w.id}`));
    const known = await db
      .selectDistinct({ externalId: structureSnapshots.externalId })
      .from(structureSnapshots)
      .where(
        and(eq(structureSnapshots.orgId, orgId), eq(structureSnapshots.connector, "n8n")),
      );

    for (const row of known) {
      if (present.has(row.externalId)) continue;

      const [node] = await db
        .select({ id: nodesTable.id })
        .from(nodesTable)
        .where(
          and(
            eq(nodesTable.orgId, orgId),
            eq(nodesTable.connector, "n8n"),
            eq(nodesTable.externalId, row.externalId),
          ),
        )
        .limit(1);

      const incidentId = await recordDetection({
        orgId,
        connector: "n8n",
        change: {
          target: "workflow",
          operation: "delete",
          connector: "n8n",
          externalId: row.externalId,
        },
        // Keyed on the disappearance itself. A workflow can only be deleted
        // once, and if it is restored and deleted again that is a new
        // transition from a fresh snapshot.
        vendorEventId: `deleted:${row.externalId}`,
        changeAt: null,
        detectPath: "poll",
        nodeId: node?.id ?? null,
      });

      if (incidentId === null) continue;
      detected += 1;

      await enqueue(
        "reflex.verdict",
        { incidentId },
        { orgId, dedupeKey: `reflex.verdict:${incidentId}`, priority: 5 },
      );
    }
  }

  return detected;
}

function deriveOperation(
  previous: N8nWorkflow,
  current: N8nWorkflow,
): "modify" | "disable" | "delete" {
  if (previous.active === true && current.active === false) return "disable";
  return "modify";
}

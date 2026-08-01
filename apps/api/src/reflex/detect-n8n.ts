import { createHash } from "node:crypto";
import {
  connectorInstances,
  nodes as nodesTable,
  structureSnapshots,
} from "@sadhak/shared/schema";
import type { ChangeDescriptor } from "@sadhak/shared/types";
import { and, desc, eq } from "drizzle-orm";
import { baseUrlFor } from "../connectors/registry.js";
import { db } from "../db.js";
import { enqueue } from "../jobs/queue.js";
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

    let workflows: N8nWorkflow[];
    try {
      const res = await fetch(
        `${baseUrlFor(instance)}/api/v1/workflows?limit=${POLL_LIMIT}`,
        {
          headers: { "X-N8N-API-KEY": secret.reveal(), accept: "application/json" },
        },
      );
      if (!res.ok) continue;
      const body = (await res.json()) as { data?: N8nWorkflow[] };
      workflows = body.data ?? [];
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
        vendorEventId: hash.slice(0, 16),
        changeAt: workflow.updatedAt ? new Date(workflow.updatedAt) : null,
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

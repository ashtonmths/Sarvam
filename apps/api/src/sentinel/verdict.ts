import {
  graphVersions,
  nodes as nodesTable,
  verdicts as verdictsTable,
} from "@sadhak/shared/schema";
import type { ChangeDescriptor, VerdictResult } from "@sadhak/shared/types";
import { and, eq } from "drizzle-orm";
import { db } from "../db.js";
import { UserError } from "../errors.js";
import { toBlastRows } from "./assemble.js";
import { verdict as scoreVerdict } from "./score.js";
import { busFactorByEdge, hydrateHops, traverse } from "./traverse.js";

/**
 * The deterministic path, composed. This module never imports `llm.ts` or
 * `explain.ts` — the boundary is asserted mechanically by a test, because it
 * is the property the whole product rests on.
 */

/** Thrown when a descriptor names something the graph has never seen. */
export class UnresolvedTargetError extends UserError {
  constructor(readonly descriptor: ChangeDescriptor) {
    super(
      `No node matches ${descriptor.connector}:${descriptor.externalId} — Sadhak cannot assess impact`,
      { status: 422, type: "unresolved-target" },
    );
  }
}

export async function resolveNode(orgId: number, change: ChangeDescriptor) {
  const [node] = await db
    .select({ id: nodesTable.id, name: nodesTable.name })
    .from(nodesTable)
    .where(
      and(
        eq(nodesTable.orgId, orgId),
        eq(nodesTable.connector, change.connector),
        eq(nodesTable.externalId, change.externalId),
      ),
    )
    .limit(1);
  return node ?? null;
}

export async function currentGraphVersion(orgId: number): Promise<number> {
  const [row] = await db
    .select({ version: graphVersions.version })
    .from(graphVersions)
    .where(eq(graphVersions.orgId, orgId))
    .limit(1);
  return row?.version ?? 0;
}

export interface RenderOptions {
  createdBy?: string | null;
  /** Skips persistence — used by read-only blast-radius queries. */
  persist?: boolean;
}

/**
 * Resolve → traverse → score → persist → return. `computedInMs` times only
 * traversal and scoring, exactly as the contract's doc comment promises.
 */
export async function renderVerdict(
  orgId: number,
  change: ChangeDescriptor,
  options: RenderOptions = {},
): Promise<VerdictResult> {
  const node = await resolveNode(orgId, change);
  if (!node) throw new UnresolvedTargetError(change);

  const started = performance.now();

  const raw = await traverse(orgId, node.id);
  const edgeIds = [...new Set(raw.flatMap((row) => row.edgeIds))];
  const [hopsById, authorsByEdge] = await Promise.all([
    hydrateHops(orgId, edgeIds),
    busFactorByEdge(orgId, edgeIds),
  ]);

  const impacted = toBlastRows(raw, hopsById, authorsByEdge);
  const { verdict, evidence } = scoreVerdict(impacted);

  const computedInMs = Math.round(performance.now() - started);
  const graphVersion = await currentGraphVersion(orgId);

  const [row] = await db
    .insert(verdictsTable)
    .values({
      orgId,
      change: change as unknown as Record<string, unknown>,
      verdict,
      impacted,
      evidence,
      graphVersion,
      computedInMs,
      createdBy: options.createdBy ?? null,
      explanationState: "pending",
    })
    .returning({ id: verdictsTable.id });

  return {
    id: row?.id ?? "",
    verdict,
    change,
    impacted,
    evidence,
    computedInMs,
    graphVersion,
    explanation: null,
    explanationState: "pending",
  };
}

/**
 * The synthesized verdict for a target the graph does not know. Never
 * APPROVE (unmapped is not safe) and never BLOCK (that is a false block on a
 * model of nothing) — a deterministic WARN that says exactly why.
 */
export async function renderUnmappedWarn(
  orgId: number,
  change: ChangeDescriptor,
  createdBy?: string | null,
): Promise<VerdictResult> {
  const graphVersion = await currentGraphVersion(orgId);
  const evidence = [
    {
      rule: "node not mapped — Sadhak cannot assess impact",
      nodeId: -1,
      name: `${change.connector}:${change.externalId}`,
      impact: 0,
    },
  ];

  const [row] = await db
    .insert(verdictsTable)
    .values({
      orgId,
      change: change as unknown as Record<string, unknown>,
      verdict: "WARN",
      impacted: [],
      evidence,
      graphVersion,
      computedInMs: 0,
      createdBy: createdBy ?? null,
      explanationState: "disabled",
    })
    .returning({ id: verdictsTable.id });

  return {
    id: row?.id ?? "",
    verdict: "WARN",
    change,
    impacted: [],
    evidence,
    computedInMs: 0,
    graphVersion,
    explanation: null,
    explanationState: "disabled",
  };
}

export async function getVerdict(
  orgId: number,
  verdictId: string,
): Promise<VerdictResult | null> {
  const [row] = await db
    .select()
    .from(verdictsTable)
    .where(and(eq(verdictsTable.id, verdictId), eq(verdictsTable.orgId, orgId)))
    .limit(1);
  if (!row) return null;

  return {
    id: row.id,
    verdict: row.verdict as VerdictResult["verdict"],
    change: row.change as unknown as ChangeDescriptor,
    impacted: row.impacted ?? [],
    evidence: row.evidence ?? [],
    computedInMs: row.computedInMs,
    graphVersion: row.graphVersion,
    explanation: row.explanation,
    explanationState: row.explanationState as VerdictResult["explanationState"],
  };
}

/** Read-only traversal for the MCP `query_blast_radius` tool. No decision row. */
export async function blastRadius(orgId: number, change: ChangeDescriptor) {
  const node = await resolveNode(orgId, change);
  if (!node) throw new UnresolvedTargetError(change);

  const raw = await traverse(orgId, node.id);
  const edgeIds = [...new Set(raw.flatMap((row) => row.edgeIds))];
  const [hopsById, authorsByEdge] = await Promise.all([
    hydrateHops(orgId, edgeIds),
    busFactorByEdge(orgId, edgeIds),
  ]);
  return toBlastRows(raw, hopsById, authorsByEdge);
}

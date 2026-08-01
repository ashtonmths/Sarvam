import {
  auditLog,
  connectorInstances,
  criticalityOverrides,
  edges,
  gateDecisions,
  members,
  miningScopes,
  nodes,
  organizations,
  rationale,
  rationaleLinks,
  reflexIncidents,
  users,
  verdicts,
} from "@sadhak/shared/schema";
import { eq } from "drizzle-orm";
import { db } from "../db.js";
import { NotFoundError } from "../errors.js";

/**
 * Everything one organisation has, as one JSON document.
 *
 * This is the portability half of the deletion/export pair. It exists so
 * "you can take your data and go" is a request you can make rather than a
 * sentence in a policy — and so the privacy page can say it without lying,
 * which is what prompted writing it.
 *
 * **Credentials are not in the export.** They are sealed with AAD binding them
 * to this org and connector instance, so the ciphertext is useless elsewhere,
 * and shipping secrets into a file that lands in a downloads folder is a worse
 * outcome than the inconvenience of re-entering them. The connector rows are
 * exported without them.
 *
 * Embeddings are excluded too: 384 floats per rationale row, reproducible from
 * the text by anyone with the model, and they would dominate the file size
 * while helping nobody reading it.
 */

/**
 * Reads the whole org. Not paginated — this is a deliberate one-shot dump.
 *
 * It buffers everything in memory and serializes in one pass, which is fine at
 * the scale this runs at today and will not be forever: the demo org alone
 * returns eight thousand verdicts, and verdicts are the table that grows
 * without bound. When an export starts costing real memory the fix is to
 * stream it as NDJSON per section rather than to paginate it, because a
 * portability export that arrives in pages is not one document and stops being
 * useful for the thing people want it for.
 */
export async function exportOrg(orgId: number) {
  const [org] = await db
    .select()
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);

  if (!org) throw new NotFoundError("Organization not found");

  const [
    memberRows,
    nodeRows,
    edgeRows,
    rationaleRows,
    rationaleLinkRows,
    verdictRows,
    decisionRows,
    instanceRows,
    incidentRows,
    overrideRows,
    scopeRows,
    auditRows,
  ] = await Promise.all([
    db
      .select({
        role: members.role,
        email: users.email,
        name: users.name,
        joinedAt: members.createdAt,
      })
      .from(members)
      .innerJoin(users, eq(users.id, members.userId))
      .where(eq(members.orgId, orgId)),
    db.select().from(nodes).where(eq(nodes.orgId, orgId)),
    db.select().from(edges).where(eq(edges.orgId, orgId)),
    // Explicit column list rather than `select()`: it drops the embedding, and
    // it means a column added later is absent until someone decides it belongs
    // in an export, instead of appearing silently.
    db
      .select({
        id: rationale.id,
        body: rationale.body,
        sourceKind: rationale.sourceKind,
        sourceUrl: rationale.sourceUrl,
        author: rationale.author,
        authoredAt: rationale.authoredAt,
        confidence: rationale.confidence,
        state: rationale.state,
        confirmedBy: rationale.confirmedBy,
        confirmedAt: rationale.confirmedAt,
        createdAt: rationale.createdAt,
      })
      .from(rationale)
      .where(eq(rationale.orgId, orgId)),
    // No org column on this join table — it is keyed on (rationaleId, edgeId).
    // Scoped through its rationale, which is where the org lives.
    db
      .select({ rationaleId: rationaleLinks.rationaleId, edgeId: rationaleLinks.edgeId })
      .from(rationaleLinks)
      .innerJoin(rationale, eq(rationale.id, rationaleLinks.rationaleId))
      .where(eq(rationale.orgId, orgId)),
    db.select().from(verdicts).where(eq(verdicts.orgId, orgId)),
    db.select().from(gateDecisions).where(eq(gateDecisions.orgId, orgId)),
    db
      .select({
        id: connectorInstances.id,
        connector: connectorInstances.connector,
        displayName: connectorInstances.displayName,
        status: connectorInstances.status,
        createdAt: connectorInstances.createdAt,
      })
      .from(connectorInstances)
      .where(eq(connectorInstances.orgId, orgId)),
    db.select().from(reflexIncidents).where(eq(reflexIncidents.orgId, orgId)),
    db.select().from(criticalityOverrides).where(eq(criticalityOverrides.orgId, orgId)),
    db.select().from(miningScopes).where(eq(miningScopes.orgId, orgId)),
    db.select().from(auditLog).where(eq(auditLog.orgId, orgId)),
  ]);

  return {
    exportedAt: new Date().toISOString(),
    format: 1,
    notes: [
      "Connector credentials are deliberately excluded. They are encrypted and bound to this organisation and connector instance, so the ciphertext would not work anywhere else.",
      "Rationale embeddings are excluded. They are derived from the body text and recomputable.",
      "Sadhak never stores the contents of your records, so none appear here.",
    ],
    organization: { id: org.id, name: org.name, createdAt: org.createdAt },
    members: memberRows,
    connectors: instanceRows,
    graph: { nodes: nodeRows, edges: edgeRows },
    rationale: rationaleRows,
    rationaleLinks: rationaleLinkRows,
    verdicts: verdictRows,
    decisions: decisionRows,
    incidents: incidentRows,
    criticalityOverrides: overrideRows,
    miningScopes: scopeRows,
    auditLog: auditRows,
  };
}

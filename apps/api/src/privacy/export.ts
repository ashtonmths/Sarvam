import {
  auditLog,
  changePaths,
  changes,
  checkpoints,
  connectorInstances,
  criticalityOverrides,
  documentChunks,
  documents,
  edges,
  gateDecisions,
  members,
  miningScopes,
  nodes,
  organizations,
  rationale,
  rationaleLinks,
  reflexIncidents,
  repositories,
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
    documentRows,
    documentChunkRows,
    repositoryRows,
    changeRows,
    changePathRows,
    checkpointRows,
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
    // Documents carry their full text, and that text is the org's own data —
    // an export that omitted it would hand back everything derived from a
    // transcript except the transcript.
    db
      .select({
        id: documents.id,
        title: documents.title,
        originalName: documents.originalName,
        content: documents.content,
        byteSize: documents.byteSize,
        occurredAt: documents.occurredAt,
        sourceUrl: documents.sourceUrl,
        uploadedBy: documents.uploadedBy,
        createdAt: documents.createdAt,
      })
      .from(documents)
      .where(eq(documents.orgId, orgId)),
    // Chunks without their embeddings, for the same reason rationale drops
    // them: 384 floats per row, reproducible from the body.
    db
      .select({
        documentId: documentChunks.documentId,
        ordinal: documentChunks.ordinal,
        body: documentChunks.body,
        speaker: documentChunks.speaker,
        startOffset: documentChunks.startOffset,
        endOffset: documentChunks.endOffset,
      })
      .from(documentChunks)
      .where(eq(documentChunks.orgId, orgId)),
    // The change log is the org's own history of its own repositories, so it
    // travels with them.
    db.select().from(repositories).where(eq(repositories.orgId, orgId)),
    // `id` is carried so change_paths below can be reattached. Without it the
    // paths would be a bare table of ids nobody could reassemble — which is
    // what the previous version's comment claimed to have solved by joining,
    // while exporting no paths at all.
    db
      .select({
        id: changes.id,
        repoId: changes.repoId,
        kind: changes.kind,
        externalId: changes.externalId,
        title: changes.title,
        body: changes.body,
        authorLogin: changes.authorLogin,
        authorEmail: changes.authorEmail,
        occurredAt: changes.occurredAt,
        url: changes.url,
      })
      .from(changes)
      .where(eq(changes.orgId, orgId)),
    // Paths are the evidence the ranker actually runs on, so an export that
    // omitted them would hand back the conclusions without the reasons.
    // Scoped through the change, which is where the org lives.
    db
      .select({
        changeId: changePaths.changeId,
        path: changePaths.path,
        status: changePaths.status,
      })
      .from(changePaths)
      .innerJoin(changes, eq(changes.id, changePaths.changeId))
      .where(eq(changes.orgId, orgId)),
    db.select().from(checkpoints).where(eq(checkpoints.orgId, orgId)),
  ]);

  return {
    exportedAt: new Date().toISOString(),
    format: 1,
    notes: [
      "Connector credentials are deliberately excluded. They are encrypted and bound to this organisation and connector instance, so the ciphertext would not work anywhere else.",
      "Rationale embeddings are excluded. They are derived from the body text and recomputable.",
      "Sadhak never reads or stores the contents of your records. It reads structure — table, column and workflow names — so none of your row data appears here.",
      "The change log records commit and pull request messages, authors and the file paths each touched. Diffs are never stored; a citation links to GitHub for those.",
      "Documents you uploaded are the one exception, and they appear in full: you gave Sadhak that text deliberately, and it is stored so a citation can be read in context. Chunk embeddings are excluded as recomputable.",
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
    documents: documentRows,
    documentChunks: documentChunkRows,
    repositories: repositoryRows,
    changes: changeRows,
    changePaths: changePathRows,
    checkpoints: checkpointRows,
  };
}

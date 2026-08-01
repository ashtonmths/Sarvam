import { documentChunks, documents } from "@sadhak/shared/schema";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { audit } from "../audit.js";
import { db } from "../db.js";
import {
  assertAcceptedName,
  deleteDocument,
  MAX_DOCUMENT_BYTES,
  uploadDocument,
} from "../documents/ingest.js";
import { NotFoundError } from "../errors.js";
import { requireCapability } from "../middleware/auth.js";

export const documentRoutes = new Hono();

/**
 * Uploaded evidence.
 *
 * `connector:manage` rather than a new capability: this is the same act as
 * connecting Slack or ticking a channel — deciding what Sadhak is allowed to
 * read on the org's behalf.
 */

const uploadSchema = z.object({
  title: z.string().min(1).max(300),
  text: z.string().min(1),
  originalName: z.string().max(300).optional(),
  occurredAt: z.string().datetime({ offset: true }).optional(),
  sourceUrl: z.string().url().optional(),
});

documentRoutes.post("/documents", requireCapability("connector:manage"), async (c) => {
  const orgId = c.get("orgId");
  const actor = c.get("actor");
  const body = uploadSchema.parse(await c.req.json());

  // Only when a filename is given. A pasted transcript has no extension and
  // should not need an invented one.
  if (body.originalName) assertAcceptedName(body.originalName);

  const result = await uploadDocument({
    orgId,
    title: body.title,
    text: body.text,
    ...(body.originalName ? { originalName: body.originalName } : {}),
    ...(body.occurredAt ? { occurredAt: new Date(body.occurredAt) } : {}),
    ...(body.sourceUrl ? { sourceUrl: body.sourceUrl } : {}),
    uploadedBy: actorLabel(actor),
  });

  if (!result.duplicate) {
    await audit(c, "document.uploaded", { kind: "document", id: result.id });
  }

  return c.json(
    {
      ...result,
      note: result.duplicate
        ? "This document was already uploaded, so nothing was stored again. The existing copy is unchanged."
        : "Chunks are queued for embedding. Text search works immediately; semantic search follows within a minute.",
    },
    result.duplicate ? 200 : 201,
  );
});

/** The list, newest first, with embedding progress so a stall is visible. */
documentRoutes.get("/documents", requireCapability("graph:read"), async (c) => {
  const orgId = c.get("orgId");

  const rows = await db
    .select({
      id: documents.id,
      title: documents.title,
      originalName: documents.originalName,
      byteSize: documents.byteSize,
      occurredAt: documents.occurredAt,
      sourceUrl: documents.sourceUrl,
      uploadedBy: documents.uploadedBy,
      createdAt: documents.createdAt,
      chunks: sql<number>`count(${documentChunks.id})::int`,
      pending: sql<number>`count(${documentChunks.id}) FILTER (WHERE ${documentChunks.embedding} IS NULL)::int`,
    })
    .from(documents)
    .leftJoin(documentChunks, eq(documentChunks.documentId, documents.id))
    .where(eq(documents.orgId, orgId))
    .groupBy(documents.id)
    .orderBy(desc(documents.createdAt));

  return c.json({ items: rows, maxBytes: MAX_DOCUMENT_BYTES });
});

/**
 * Embedding backlog, so a stuck worker is visible rather than inferred.
 *
 * Declared before `/documents/:id`, because Hono matches in registration order
 * and the parameterised route would otherwise swallow this path and answer 404
 * for a literal that is not a number.
 */
documentRoutes.get(
  "/documents/embed-status",
  requireCapability("graph:read"),
  async (c) => {
    const orgId = c.get("orgId");
    const [row] = await db
      .select({ pending: sql<number>`count(*)::int` })
      .from(documentChunks)
      .where(and(eq(documentChunks.orgId, orgId), isNull(documentChunks.embedding)));

    return c.json({ pending: row?.pending ?? 0 });
  },
);

/**
 * One document with its chunks, which is what a citation resolves to. The
 * chunk offsets are returned so the page can highlight the quoted span inside
 * the surrounding text rather than showing the chunk alone — context is the
 * reason a reviewer clicks a citation at all.
 */
documentRoutes.get("/documents/:id", requireCapability("graph:read"), async (c) => {
  const orgId = c.get("orgId");
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id)) throw new NotFoundError("No such document");

  const [document] = await db
    .select()
    .from(documents)
    .where(and(eq(documents.orgId, orgId), eq(documents.id, id)))
    .limit(1);

  if (!document) throw new NotFoundError("No such document");

  const chunks = await db
    .select({
      ordinal: documentChunks.ordinal,
      body: documentChunks.body,
      speaker: documentChunks.speaker,
      startOffset: documentChunks.startOffset,
      endOffset: documentChunks.endOffset,
      embedded: sql<boolean>`${documentChunks.embedding} IS NOT NULL`,
    })
    .from(documentChunks)
    .where(eq(documentChunks.documentId, document.id))
    .orderBy(documentChunks.ordinal);

  return c.json({ document, chunks });
});

/**
 * Deleting removes the document and its chunks. Rationale already quoted from
 * it stays: the quote was true and a human confirmed it, and dropping a
 * confirmed row would move the coverage metric behind someone's back.
 */
documentRoutes.delete(
  "/documents/:id",
  requireCapability("connector:manage"),
  async (c) => {
    const orgId = c.get("orgId");
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id)) throw new NotFoundError("No such document");

    const deleted = await deleteDocument(orgId, id);
    if (!deleted) throw new NotFoundError("No such document");

    await audit(c, "document.deleted", { kind: "document", id });
    return c.json({
      ok: true,
      note: "Rationale already sourced from this document is kept, and its citation now points at a document that no longer exists.",
    });
  },
);

function actorLabel(actor: { type: string; id: number } | undefined): string {
  if (!actor) return "unknown";
  return actor.type === "api_key" ? `api_key:${actor.id}` : `user:${actor.id}`;
}

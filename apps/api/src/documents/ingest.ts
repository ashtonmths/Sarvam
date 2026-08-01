import { createHash } from "node:crypto";
import { documentChunks, documents } from "@sadhak/shared/schema";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { auditSystem } from "../audit.js";
import { db } from "../db.js";
import { UserError } from "../errors.js";
import { enqueue } from "../jobs/queue.js";
import { chunkDocument, normalizeText } from "./chunk.js";

/**
 * Upload is the third way evidence gets in, next to a crawl and a mined
 * search. It exists because the reason for a decision is often spoken: it is
 * in a call transcript, in a handover doc, in notes nobody will ever move into
 * Slack. Without a way to bring those in, the Historian can only find rationale
 * that happened to be typed into a system we crawl.
 */

/** Roughly a very long meeting. Also bounds one upload's chunk count. */
export const MAX_DOCUMENT_BYTES = 2 * 1024 * 1024;

export const uploadInputSchema = z.object({
  orgId: z.number().int(),
  title: z.string().min(1).max(300),
  text: z.string().min(1),
  originalName: z.string().max(300).optional(),
  /** When the meeting happened. Not when it was uploaded. */
  occurredAt: z.coerce.date().optional(),
  /** Where it came from, for provenance. Citations never point at it. */
  sourceUrl: z.string().url().optional(),
  uploadedBy: z.string().min(1).max(200),
});

export type UploadInput = z.infer<typeof uploadInputSchema>;

export interface UploadedDocument {
  id: number;
  title: string;
  chunkCount: number;
  /** True when this exact content was already stored and nothing was written. */
  duplicate: boolean;
}

/** The extensions the text path accepts. PDF and docx are deliberately absent. */
const ACCEPTED = [".txt", ".md", ".markdown", ".vtt", ".srt", ".text", ".log"];

export function assertAcceptedName(name: string): void {
  const lower = name.toLowerCase();
  if (!ACCEPTED.some((extension) => lower.endsWith(extension))) {
    throw new UserError(
      `Sadhak reads text documents: ${ACCEPTED.join(", ")}. Export a transcript as text or paste it directly.`,
      { status: 422 },
    );
  }
}

export async function uploadDocument(raw: UploadInput): Promise<UploadedDocument> {
  const input = uploadInputSchema.parse(raw);
  const content = normalizeText(input.text);
  const byteSize = Buffer.byteLength(content, "utf8");

  if (byteSize > MAX_DOCUMENT_BYTES) {
    throw new UserError(
      `That document is ${Math.round(byteSize / 1024)}KB and the limit is ${MAX_DOCUMENT_BYTES / 1024}KB. Split it, or upload the section that carries the decision.`,
      { status: 413 },
    );
  }

  const chunks = chunkDocument(content);
  if (chunks.length === 0) {
    throw new UserError("That document has no readable text in it.", { status: 422 });
  }

  /**
   * Hash first: an upload retried after a timeout must not produce a second
   * copy competing with the first in every search. The unique index is what
   * actually enforces it; this read just makes the common case a clean answer
   * instead of a constraint error.
   */
  const contentHash = createHash("sha256").update(content).digest("hex");
  const existing = await findByHash(input.orgId, contentHash);
  if (existing) {
    return {
      id: existing.id,
      title: existing.title,
      chunkCount: chunks.length,
      duplicate: true,
    };
  }

  /**
   * Document and chunks in one transaction. A half-chunked document is worse
   * than no document: it is searchable, looks complete, and silently omits
   * whatever the crash interrupted.
   */
  const documentId = await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(documents)
      .values({
        orgId: input.orgId,
        title: input.title,
        content,
        contentHash,
        byteSize,
        ...(input.originalName ? { originalName: input.originalName } : {}),
        ...(input.occurredAt ? { occurredAt: input.occurredAt } : {}),
        ...(input.sourceUrl ? { sourceUrl: input.sourceUrl } : {}),
        uploadedBy: input.uploadedBy,
      })
      .onConflictDoNothing()
      .returning({ id: documents.id });

    // Lost a race against a concurrent identical upload.
    if (!row) return null;

    await tx.insert(documentChunks).values(
      chunks.map((chunk) => ({
        orgId: input.orgId,
        documentId: row.id,
        ordinal: chunk.ordinal,
        body: chunk.body,
        speaker: chunk.speaker,
        startOffset: chunk.startOffset,
        endOffset: chunk.endOffset,
        tokenEstimate: chunk.tokenEstimate,
        // Embedding is computed on the worker; the request path never loads
        // transformers.js, for the same reason rationale does not.
        embedding: null,
      })),
    );

    return row.id;
  });

  if (documentId === null) {
    const raced = await findByHash(input.orgId, contentHash);
    if (!raced) throw new Error("failed to store document");
    return {
      id: raced.id,
      title: raced.title,
      chunkCount: chunks.length,
      duplicate: true,
    };
  }

  await enqueue("document.embed", {}, { dedupeKey: "document.embed" });

  await auditSystem(
    "document.uploaded",
    input.orgId,
    { kind: "document", id: documentId },
    { title: input.title, chunks: chunks.length, byteSize },
  );

  return {
    id: documentId,
    title: input.title,
    chunkCount: chunks.length,
    duplicate: false,
  };
}

async function findByHash(
  orgId: number,
  contentHash: string,
): Promise<{ id: number; title: string } | null> {
  const [row] = await db
    .select({ id: documents.id, title: documents.title })
    .from(documents)
    .where(and(eq(documents.orgId, orgId), eq(documents.contentHash, contentHash)))
    .limit(1);
  return row ?? null;
}

/**
 * Deleting a document leaves rationale already quoted from it in place. The
 * quote stays true and the reviewer who confirmed it still confirmed it —
 * silently dropping a confirmed row would move a metric this codebase is
 * careful never to move behind someone's back. The citation link goes dead,
 * and the document page says why.
 */
export async function deleteDocument(
  orgId: number,
  documentId: number,
): Promise<boolean> {
  const deleted = await db
    .delete(documents)
    .where(and(eq(documents.orgId, orgId), eq(documents.id, documentId)))
    .returning({ id: documents.id });

  if (deleted.length === 0) return false;

  await auditSystem("document.deleted", orgId, { kind: "document", id: documentId }, {});
  return true;
}

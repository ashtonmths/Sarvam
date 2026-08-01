import { config } from "../config.js";
import { sql as raw } from "../db.js";
import { embed } from "../embed.js";

/**
 * Hybrid FTS + vector retrieval over document chunks, fused by Reciprocal Rank
 * Fusion — the same shape as historian/retrieve.ts, for the same reason: a
 * transcript names things verbatim (`vat_rate`, `eu_vat_report`) *and* talks
 * around them ("the tax column the finance report needs"), so lexical and
 * semantic each find what the other misses.
 *
 * The lexical branch must use the exact `to_tsvector('english', body)`
 * expression the migration indexed, or it silently loses the GIN index.
 */

export interface DocumentHit {
  documentId: number;
  chunkOrdinal: number;
  title: string;
  body: string;
  speaker: string | null;
  occurredAt: Date | null;
  permalink: string;
  score: number;
}

/**
 * Citations point at Sadhak, not at wherever the file came from.
 *
 * That is the whole reason uploads store their text: the permalink has to
 * resolve to the quoted span in its surrounding context, and a pasted Drive
 * link may be dead, permissioned, or simply wrong. Sadhak is the authority for
 * a document it was given.
 */
export function documentPermalink(documentId: number): string {
  const origin = (config.WEB_ORIGINS[0] ?? "").replace(/\/$/, "");
  return `${origin}/app/documents/${documentId}`;
}

export function chunkPermalink(documentId: number, ordinal: number): string {
  return `${documentPermalink(documentId)}#chunk-${ordinal}`;
}

/** Parses a permalink back to its ids. Returns null for anything else. */
export function parseChunkPermalink(
  url: string,
): { documentId: number; ordinal: number } | null {
  const match = /\/app\/documents\/(\d+)#chunk-(\d+)$/.exec(url);
  const documentId = Number(match?.[1]);
  const ordinal = Number(match?.[2]);
  if (!Number.isInteger(documentId) || !Number.isInteger(ordinal)) return null;
  return { documentId, ordinal };
}

/** Null, a Date, or a timestamp string — always a Date or null out. */
function toDate(value: Date | string | null): Date | null {
  if (value === null) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export async function searchDocuments(
  orgId: number,
  query: string,
  limit = 8,
): Promise<DocumentHit[]> {
  let vector: string | null = null;
  try {
    vector = `[${(await embed(query)).join(",")}]`;
  } catch {
    // The lexical branch still matches, so retrieval never blocks on the embed
    // model being unavailable or the embed backlog being non-empty.
  }

  const rows = (await raw`
    WITH lex AS (
      SELECT id, row_number() OVER (
        ORDER BY ts_rank_cd(to_tsvector('english', body),
                            websearch_to_tsquery('english', ${query})) DESC) AS r
      FROM document_chunks
      WHERE org_id = ${orgId}
        AND to_tsvector('english', body) @@ websearch_to_tsquery('english', ${query})
      ORDER BY ts_rank_cd(to_tsvector('english', body),
                          websearch_to_tsquery('english', ${query})) DESC
      LIMIT 40
    ), sem AS (
      SELECT id, row_number() OVER (ORDER BY embedding <=> ${vector}::vector) AS r
      FROM document_chunks
      WHERE org_id = ${orgId}
        AND embedding IS NOT NULL
        AND ${vector}::text IS NOT NULL
      ORDER BY embedding <=> ${vector}::vector
      LIMIT 40
    )
    SELECT c.id, c.document_id, c.ordinal, c.body, c.speaker,
           d.title, d.occurred_at,
           COALESCE(1.0/(60+lex.r), 0) + COALESCE(1.0/(60+sem.r), 0) AS score
    FROM document_chunks c
    JOIN documents d ON d.id = c.document_id
    LEFT JOIN lex ON lex.id = c.id
    LEFT JOIN sem ON sem.id = c.id
    WHERE (lex.id IS NOT NULL OR sem.id IS NOT NULL)
    ORDER BY score DESC, c.id
    LIMIT ${limit}
  `) as unknown as Array<{
    document_id: string | number;
    ordinal: number;
    body: string;
    speaker: string | null;
    title: string;
    // string, not Date. The driver hands back a Date for a plain timestamptz
    // column, but this one arrives through a CTE and a union and comes back as
    // text — and the `as unknown as` above is an assertion, so the compiler
    // believed whatever was written here. It said Date, callers called
    // .toISOString(), and the first one to do so got a 500 at runtime with
    // nothing failing at build time.
    occurred_at: Date | string | null;
    score: string | number;
  }>;

  return rows.map((row) => ({
    documentId: Number(row.document_id),
    chunkOrdinal: Number(row.ordinal),
    title: row.title,
    body: row.body,
    speaker: row.speaker,
    // Coerced here rather than at each call site, so DocumentHit.occurredAt is
    // actually the Date its type promises. Fixing it in the route would have
    // left the same trap set for the next caller.
    occurredAt: toDate(row.occurred_at),
    permalink: chunkPermalink(Number(row.document_id), Number(row.ordinal)),
    score: Number(row.score),
  }));
}

/**
 * Confirms a chunk permalink belongs to this org.
 *
 * Used by the citation scope check, which cannot answer this by matching
 * strings the way it does for Slack and GitHub: a document URL carries an id,
 * not a channel or a repo, so ownership is a lookup or it is nothing.
 */
export async function chunkBelongsToOrg(orgId: number, url: string): Promise<boolean> {
  const parsed = parseChunkPermalink(url);
  if (!parsed) return false;

  const [row] = (await raw`
    SELECT 1 AS ok
    FROM document_chunks c
    WHERE c.org_id = ${orgId}
      AND c.document_id = ${parsed.documentId}
      AND c.ordinal = ${parsed.ordinal}
    LIMIT 1
  `) as unknown as Array<{ ok: number }>;

  return Boolean(row);
}

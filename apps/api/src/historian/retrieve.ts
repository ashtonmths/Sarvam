import { sql as raw } from "../db.js";
import { embed } from "../embed.js";

/**
 * Hybrid FTS + vector retrieval, fused by Reciprocal Rank Fusion so lexical
 * and cosine scores need no normalization against each other.
 *
 * Retrieval strategy dominates embedding choice at this corpus size: node
 * names like `vat_rate` appear verbatim in the threads being searched, so FTS
 * and cosine rank together, in one query, in the one Postgres.
 *
 * The lexical branch must use the exact `to_tsvector('english', body)`
 * expression the migration indexed — a differing call silently loses the GIN
 * index and degrades to a sequential scan.
 */

export interface RetrievedRow {
  id: number;
  body: string;
  sourceUrl: string;
  author: string | null;
  state: string;
  score: number;
}

export interface RetrieveOptions {
  states?: string[];
  limit?: number;
}

export async function retrieveRationale(
  orgId: number,
  query: string,
  options: RetrieveOptions = {},
): Promise<RetrievedRow[]> {
  const states = options.states ?? ["confirmed", "drafted"];
  const limit = options.limit ?? 8;

  let vector: string | null = null;
  try {
    vector = `[${(await embed(query)).join(",")}]`;
  } catch {
    // The lexical branch still matches, so retrieval never blocks on the
    // embed model being unavailable or the embed lag being non-zero.
  }

  const rows = (await raw`
    WITH lex AS (
      SELECT id, row_number() OVER (
        ORDER BY ts_rank_cd(to_tsvector('english', body),
                            websearch_to_tsquery('english', ${query})) DESC) AS r
      FROM rationale
      WHERE org_id = ${orgId}
        AND state = ANY(${states})
        AND to_tsvector('english', body) @@ websearch_to_tsquery('english', ${query})
      LIMIT 40
    ), sem AS (
      SELECT id, row_number() OVER (ORDER BY embedding <=> ${vector}::vector) AS r
      FROM rationale
      WHERE org_id = ${orgId}
        AND state = ANY(${states})
        AND embedding IS NOT NULL
        AND ${vector}::text IS NOT NULL
      ORDER BY embedding <=> ${vector}::vector
      LIMIT 40
    )
    SELECT rat.id, rat.body, rat.source_url, rat.author, rat.state,
           COALESCE(1.0/(60+lex.r), 0) + COALESCE(1.0/(60+sem.r), 0) AS score
    FROM rationale rat
    LEFT JOIN lex ON lex.id = rat.id
    LEFT JOIN sem ON sem.id = rat.id
    WHERE (lex.id IS NOT NULL OR sem.id IS NOT NULL)
    ORDER BY score DESC
    LIMIT ${limit}
  `) as unknown as Array<{
    id: string | number;
    body: string;
    source_url: string;
    author: string | null;
    state: string;
    score: string | number;
  }>;

  return rows.map((row) => ({
    id: Number(row.id),
    body: row.body,
    sourceUrl: row.source_url,
    author: row.author,
    state: row.state,
    score: Number(row.score),
  }));
}

/** Confirmed and pending, reported as two numbers — never summed. */
export async function coverage(orgId: number): Promise<{
  coverageConfirmed: number;
  coveragePending: number;
  totalEdges: number;
}> {
  const [row] = (await raw`
    SELECT
      count(*) FILTER (WHERE EXISTS (
        SELECT 1 FROM rationale_links rl JOIN rationale r ON r.id = rl.rationale_id
        WHERE rl.edge_id = e.id AND r.state = 'confirmed'))::int AS covered,
      count(*) FILTER (WHERE NOT EXISTS (
        SELECT 1 FROM rationale_links rl JOIN rationale r ON r.id = rl.rationale_id
        WHERE rl.edge_id = e.id AND r.state = 'confirmed')
        AND EXISTS (
        SELECT 1 FROM rationale_links rl JOIN rationale r ON r.id = rl.rationale_id
        WHERE rl.edge_id = e.id AND r.state = 'drafted'))::int AS pending,
      count(*)::int AS total
    FROM edges e WHERE e.org_id = ${orgId}
  `) as unknown as Array<{ covered: number; pending: number; total: number }>;

  return {
    coverageConfirmed: row?.covered ?? 0,
    coveragePending: row?.pending ?? 0,
    totalEdges: row?.total ?? 0,
  };
}

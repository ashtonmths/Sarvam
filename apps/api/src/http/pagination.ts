import { z } from "zod";
import { UserError } from "../errors.js";

/**
 * Cursor pagination, settled once for the whole repo. Every list endpoint
 * returns `{ items, nextCursor }` through this helper and never invents a
 * paging parameter. No total count: counting a forever-growing table on every
 * page is exactly what cursor pagination buys us out of.
 *
 * The sort key is always tie-broken by id, so rows can be neither skipped nor
 * duplicated when the table grows under a paging reader.
 */

export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 200;

export const paginationQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
  cursor: z.string().optional(),
});

export type PaginationQuery = z.infer<typeof paginationQuerySchema>;

/** The sort-key tuple a cursor carries. Opaque to callers. */
export interface CursorPayload {
  /** Primary sort value, serialized (ISO date or number as string). */
  k: string;
  /** Tie-breaker id. */
  i: number;
}

export function encodeCursor(payload: CursorPayload): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

/** A tampered or unparseable cursor is a 400, never a 500. */
export function decodeCursor(cursor: string): CursorPayload {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    const shape = z.object({ k: z.string(), i: z.number().int() }).parse(parsed);
    return shape;
  } catch {
    throw new UserError("Invalid cursor", { type: "validation" });
  }
}

export function parsePagination(query: Record<string, string | undefined>): {
  limit: number;
  cursor: CursorPayload | null;
} {
  const parsed = paginationQuerySchema.safeParse(query);
  if (!parsed.success) {
    throw new UserError(`limit must be an integer between 1 and ${MAX_LIMIT}`, {
      type: "validation",
    });
  }
  return {
    limit: parsed.data.limit,
    cursor: parsed.data.cursor ? decodeCursor(parsed.data.cursor) : null,
  };
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

/**
 * Takes `limit + 1` rows, trims the probe row, and mints the next cursor from
 * the last returned row's sort key.
 */
export function paginated<T>(
  rows: T[],
  limit: number,
  keyOf: (row: T) => CursorPayload,
): Page<T> {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = items[items.length - 1];
  return {
    items,
    nextCursor: hasMore && last ? encodeCursor(keyOf(last)) : null,
  };
}

import { describe, expect, it } from "vitest";
import { UserError } from "../errors.js";
import {
  decodeCursor,
  encodeCursor,
  MAX_LIMIT,
  paginated,
  parsePagination,
} from "./pagination.js";

describe("cursor encoding", () => {
  it("round-trips a sort-key tuple", () => {
    const cursor = encodeCursor({ k: "2026-07-22T09:00:00.000Z", i: 42 });
    expect(decodeCursor(cursor)).toEqual({ k: "2026-07-22T09:00:00.000Z", i: 42 });
  });

  it("treats a tampered cursor as a 400, never a 500", () => {
    expect(() => decodeCursor("not-base64-at-all!!")).toThrow(UserError);
    expect(() => decodeCursor(Buffer.from('{"k":1}').toString("base64url"))).toThrow(
      UserError,
    );
  });
});

describe("parsePagination", () => {
  it("defaults to 50", () => {
    expect(parsePagination({}).limit).toBe(50);
  });

  it("rejects a limit outside the range instead of silently clamping", () => {
    expect(() => parsePagination({ limit: "0" })).toThrow(UserError);
    expect(() => parsePagination({ limit: "500" })).toThrow(UserError);
    expect(parsePagination({ limit: String(MAX_LIMIT) }).limit).toBe(MAX_LIMIT);
  });
});

describe("paginated", () => {
  const rows = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ id: 100 - i, at: `2026-07-${22 - i}` }));
  const keyOf = (row: { id: number; at: string }) => ({ k: row.at, i: row.id });

  it("trims the probe row and mints a cursor when more remain", () => {
    const page = paginated(rows(4), 3, keyOf);
    expect(page.items).toHaveLength(3);
    expect(page.nextCursor).not.toBeNull();
    expect(decodeCursor(page.nextCursor as string).i).toBe(98);
  });

  it("returns a null cursor on the last page", () => {
    const page = paginated(rows(2), 3, keyOf);
    expect(page.items).toHaveLength(2);
    expect(page.nextCursor).toBeNull();
  });

  it("is stable across an insert: the next page resumes below the last key", () => {
    // Page one over a descending list.
    const first = paginated(rows(4), 3, keyOf);
    const resume = decodeCursor(first.nextCursor as string);

    // A newer row arrives at the head — it sorts above the cursor, so paging
    // by (sort key, id) can neither skip nor duplicate what page two returns.
    const withInsert = [{ id: 101, at: "2026-07-23" }, ...rows(4)];
    const pageTwo = withInsert.filter(
      (row) => row.at < resume.k || (row.at === resume.k && row.id < resume.i),
    );
    expect(pageTwo.map((r) => r.id)).toEqual([97]);
    expect(pageTwo.some((r) => r.id === 101)).toBe(false);
  });
});

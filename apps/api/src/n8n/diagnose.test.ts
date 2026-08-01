import { describe, expect, it } from "vitest";
import { looksLikeSchemaChange, parseDiagnosis } from "./diagnose.js";

/**
 * The two decisions that change what the model is told, and what it is allowed
 * to say back.
 *
 * Schema detection is the one hint that materially shifts a diagnosis: a
 * workflow that queried a column yesterday and cannot today is almost always a
 * migration, and if that fact is missing from the context the model reaches for
 * a plausible general explanation instead.
 */

const change = (over: Partial<{ paths: string[]; title: string | null }> = {}) => ({
  external_id: "abc1234",
  title: null,
  author: null,
  occurred_at: new Date("2026-08-01T10:00:00Z"),
  paths: [],
  ...over,
});

describe("looksLikeSchemaChange", () => {
  it("spots a migration by path", () => {
    expect(
      looksLikeSchemaChange([change({ paths: ["db/migrations/0021_add_col.sql"] })]),
    ).toBe(true);
  });

  it("spots a drizzle schema edit", () => {
    expect(
      looksLikeSchemaChange([change({ paths: ["packages/shared/src/schema.ts"] })]),
    ).toBe(true);
  });

  it("spots one described only in the message", () => {
    expect(
      looksLikeSchemaChange([change({ title: "drop column invoices.vat_rate" })]),
    ).toBe(true);
  });

  it("does not fire on ordinary application code", () => {
    expect(
      looksLikeSchemaChange([
        change({
          paths: ["apps/web/components/topnav.tsx"],
          title: "move the ask button",
        }),
      ]),
    ).toBe(false);
  });

  /** A false positive costs one line of context; a false negative hides the
   * most common cause there is. The bias is deliberate, and pinned. */
  it("fires if any change in the window looks like schema, not only the first", () => {
    expect(
      looksLikeSchemaChange([
        change({ paths: ["README.md"] }),
        change({ paths: ["db/migrations/0022_x.sql"] }),
      ]),
    ).toBe(true);
  });
});

describe("parseDiagnosis", () => {
  it("accepts fenced JSON, which models emit despite instructions", () => {
    const parsed = parseDiagnosis(
      '```json\n{"cause":"the column was dropped","recommendation":"restore it","confidence":0.8,"evidence":[]}\n```',
    );
    expect(parsed?.cause).toBe("the column was dropped");
    expect(parsed?.confidence).toBe(0.8);
  });

  it("refuses a diagnosis with no cause rather than storing an empty finding", () => {
    expect(parseDiagnosis('{"recommendation":"do something"}')).toBeNull();
    expect(parseDiagnosis("I think the migration broke it.")).toBeNull();
    expect(parseDiagnosis(null)).toBeNull();
  });

  it("normalises a percentage-style confidence", () => {
    expect(parseDiagnosis('{"cause":"x","confidence":95}')?.confidence).toBe(0.95);
  });

  it("drops evidence entries with no detail", () => {
    const parsed = parseDiagnosis(
      '{"cause":"x","evidence":[{"source":"change","detail":"abc1234"},{"source":"error"}]}',
    );
    expect(parsed?.evidence).toEqual([{ source: "change", detail: "abc1234" }]);
  });
});

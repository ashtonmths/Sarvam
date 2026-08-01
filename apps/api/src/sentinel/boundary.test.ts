import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The architectural line this whole product rests on: the deterministic
 * verdict path never touches a model.
 *
 * Crude, effective, and it fails the moment someone erodes the boundary under
 * deadline pressure — which is exactly when it would happen.
 */

function source(relative: string): string {
  return readFileSync(new URL(relative, import.meta.url), "utf8");
}

describe("the deterministic path imports no model client", () => {
  for (const file of ["./traverse.ts", "./score.ts", "./verdict.ts", "./assemble.ts"]) {
    it(`${file} does not import llm.ts or explain.ts`, () => {
      const text = source(file);
      expect(text).not.toMatch(/from\s+["'].*\/llm\.js["']/);
      expect(text).not.toMatch(/from\s+["'].*explain\.js["']/);
      expect(text).not.toMatch(/openrouter/i);
    });
  }

  it("keeps every provider call in exactly one file", () => {
    // `llm.ts` is what makes the free→paid move an env-var change, and this is
    // what keeps that true.
    const llm = source("../llm.ts");
    expect(llm).toContain("openrouter.ai");

    for (const file of ["./explain.ts", "../historian/loop.ts"]) {
      expect(source(file)).not.toContain("openrouter.ai");
    }
  });

  it("routes every gate door through the one decide() wrapper", () => {
    // Three doors, one engine. A second engine is how they drift.
    const decide = source("../gate/decide.ts");
    expect(decide).toContain("renderVerdict");
    expect(decide).not.toMatch(/from\s+["'].*\/llm\.js["']/);
  });
});

describe("connectors cannot write the graph or claim a confidence", () => {
  it("assigns CONFIDENCE only in normalize.ts", () => {
    const normalize = source("../cartographer/normalize.ts");
    expect(normalize).toContain("export const CONFIDENCE");

    for (const connector of [
      "../connectors/n8n/index.ts",
      "../connectors/airtable/index.ts",
      "../connectors/postgres/index.ts",
    ]) {
      const text = source(connector);
      expect(text).not.toContain("CONFIDENCE");
      // A connector that imports the db could bypass the single write path.
      expect(text).not.toMatch(/from\s+["']\.\.\/\.\.\/db\.js["']/);
    }
  });

  it("does not let a connector name llm_inferred", () => {
    // Cartographer is deterministic ETL. That provenance belongs to Historian
    // and Reviewer alone, and the connector type union omits it.
    const types = source("../connectors/types.ts");
    expect(types).toContain(
      'export type ConnectorProvenance = "static_parse" | "runtime_observed"',
    );
    expect(types).not.toMatch(/ConnectorProvenance[^;]*llm_inferred/);
  });
});

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { GOLDEN_CASES } from "./goldens/cases.js";
import { verdict } from "./score.js";

/**
 * The determinism corpus.
 *
 * "Same graph, same change, same verdict, every time" is the audit-trail
 * property the whole product rests on — it is why the gate can be trusted, why
 * a decision can be replayed months later, and why an argument about a verdict
 * is settleable. A golden diff in a pull request is that claim being checked
 * by a human rather than asserted in a README.
 *
 * Regenerate deliberately:
 *
 *   UPDATE_GOLDENS=1 pnpm vitest run apps/api/src/sentinel/score.goldens.test.ts
 *
 * A golden change with no scoring change in the same pull request is a red
 * flag. It means either a threshold moved without anyone saying so, or the
 * corpus was updated to match a bug.
 */

const DIR = new URL("./goldens/", import.meta.url);
// Read directly rather than through config.ts: this is a developer-invoked
// flag for regenerating the corpus, and putting it in the production env
// schema would document a knob no deployment ever sets.
const UPDATE = process.env.UPDATE_GOLDENS === "1";

interface Golden {
  /** Copied in so a reviewer reads the intent beside the diff. */
  pins: string;
  verdict: string;
  evidence: Array<{ rule: string; nodeId: number; name: string; impact: number }>;
}

function goldenPath(name: string): string {
  return fileURLToPath(new URL(`${name}.json`, DIR));
}

describe("verdict goldens", () => {
  if (UPDATE) {
    mkdirSync(fileURLToPath(DIR), { recursive: true });
  }

  for (const testCase of GOLDEN_CASES) {
    it(`${testCase.name}: ${testCase.pins}`, () => {
      const result = verdict(testCase.rows);
      const actual: Golden = {
        pins: testCase.pins,
        verdict: result.verdict,
        evidence: result.evidence,
      };

      const path = goldenPath(testCase.name);

      if (UPDATE) {
        writeFileSync(path, `${JSON.stringify(actual, null, 2)}\n`);
        return;
      }

      expect(
        existsSync(path),
        `No golden for "${testCase.name}". Run UPDATE_GOLDENS=1 to create it, and explain the verdict in the pull request.`,
      ).toBe(true);

      const expected = JSON.parse(readFileSync(path, "utf8")) as Golden;
      expect(actual.verdict).toBe(expected.verdict);
      expect(actual.evidence).toEqual(expected.evidence);
    });
  }

  it("runs twice with the same answer, which is the actual claim", () => {
    // Determinism is not "it passed once". Two evaluations of the same input
    // must be byte-identical, or the audit trail is a story rather than a
    // record.
    for (const testCase of GOLDEN_CASES) {
      const first = JSON.stringify(verdict(testCase.rows));
      const second = JSON.stringify(verdict(testCase.rows));
      expect(second, `${testCase.name} is not reproducible`).toBe(first);
    }
  });

  it("does not mutate the rows it was handed", () => {
    // A kernel that edits its input scores differently on a second pass, which
    // is the sneakiest way to lose reproducibility.
    for (const testCase of GOLDEN_CASES) {
      const before = JSON.stringify(testCase.rows);
      verdict(testCase.rows);
      expect(JSON.stringify(testCase.rows), `${testCase.name} was mutated`).toBe(before);
    }
  });

  it("is insensitive to the order rows arrive in", () => {
    // Traversal order is a database implementation detail. If it changed the
    // verdict, the same graph would score differently after a VACUUM.
    for (const testCase of GOLDEN_CASES) {
      if (testCase.rows.length < 2) continue;
      const forward = verdict(testCase.rows).verdict;
      const backward = verdict([...testCase.rows].reverse()).verdict;
      expect(backward, `${testCase.name} depends on row order`).toBe(forward);
    }
  });
});

/**
 * Mutation testing, pointed at the code where a surviving mutant actually
 * matters.
 *
 * Coverage says a line ran. Mutation testing asks whether anything would have
 * noticed if that line were wrong — which is the question worth asking about a
 * scoring kernel that decides whether someone's change is blocked.
 *
 * **Scoped deliberately.** Mutating the whole API would take hours and mostly
 * report surviving mutants in glue code, where the honest answer is "yes, and
 * that is fine". The files here are the ones where a silent behaviour change is
 * a wrong verdict or a missed drift finding:
 *
 *   score.ts          the verdict itself — thresholds, the confidence gate
 *   hash.ts           canonicalization; over-stripping hides real drift
 *   concentration.ts  banding, where a wrong boundary misreports risk
 *
 * The threshold is a gate, not a score to admire. `break` fails the run, and it
 * is set at the level currently achieved rather than an aspiration, so it
 * ratchets: improving the suite raises it, and nothing may lower it silently.
 *
 *   pnpm test:mutation
 */
export default {
  packageManager: "pnpm",
  testRunner: "vitest",
  // Named explicitly: pnpm's isolated node_modules means Stryker's plugin
  // auto-discovery finds nothing from the workspace root.
  plugins: ["@stryker-mutator/vitest-runner"],
  vitest: {
    configFile: "vitest.config.ts",
    // `related` asks vitest which tests touch a mutated file, and it cannot
    // resolve our `.js` ESM specifiers back to their `.ts` sources, so it
    // finds nothing. Running the whole unit suite per mutant is slower and
    // correct, which is the right trade for three files.
    related: false,
  },
  mutate: [
    "apps/api/src/sentinel/score.ts",
    "apps/api/src/reviewer/hash.ts",
    "apps/api/src/reviewer/concentration.ts",
  ],
  reporters: ["progress", "clear-text"],
  clearTextReporter: { maxTestsToLog: 3 },
  // Kept out of the repo: a report is an artifact of a run, not a source file.
  tempDirName: "node_modules/.stryker-tmp",
  // Set at what is currently achieved, so it ratchets: improving the suite
  // raises it, and nothing may lower it without the diff being visible.
  // Measured 2026-07-26: 89.36 overall, score.ts 98.28.
  thresholds: { high: 95, low: 85, break: 89 },
  timeoutMS: 20_000,
  concurrency: 4,
};

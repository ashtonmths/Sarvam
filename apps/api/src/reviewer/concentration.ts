/**
 * Knowledge concentration: how many people can actually explain a dependency.
 *
 * The naive version — count distinct authors of the Slack messages we happened
 * to index — is the one this replaces, because "one person wrote the message we
 * found" is not "one person understands the system". It is confidently wrong in
 * both directions: a system three people maintain looks like a bus factor of
 * one because only one of them writes things down, and a system nobody
 * understands looks healthy because five people once argued in a thread.
 *
 * So: three independent signals, a **band** rather than a number, and a human
 * override that wins. The band is the honesty mechanism — "high risk" is a
 * claim this evidence can support, "bus factor: 1" is not.
 */

export interface ConcentrationSignals {
  /** Distinct authors of confirmed rationale on this node's edges. */
  rationaleAuthors: Set<string>;
  /** Distinct commit and PR authors on artifacts referencing the node. */
  artifactAuthors: Set<string>;
  /** Distinct humans who confirmed rationale or resolved drift here. */
  interactors: Set<string>;
}

export type ConcentrationBand = "high" | "medium" | "low" | "unknown";

export interface Concentration {
  band: ConcentrationBand;
  /** Distinct people across all three signals. Reported, never the headline. */
  distinctPeople: number;
  /** How many of the three signals produced anything at all. */
  signalsPresent: number;
  /** Plain sentence for the UI, so a band never appears without its reason. */
  reason: string;
}

export interface ConcentrationOverride {
  band: Exclude<ConcentrationBand, "unknown">;
  reason: string;
  by: string;
}

/**
 * `high` means concentration risk is high — few people, so losing one hurts.
 *
 * The naming is deliberate: a field called `busFactor` reading `1` invites
 * "we have a bus factor of one" as a stated fact, when the honest claim is
 * "the evidence we have points at one person, and our evidence is partial".
 */
export function concentration(
  signals: ConcentrationSignals,
  override?: ConcentrationOverride,
): Concentration {
  // A human who looked wins over three proxies. These corrections are the
  // compounding asset — nobody can reconstruct them by crawling.
  if (override) {
    return {
      band: override.band,
      distinctPeople: distinct(signals).size,
      signalsPresent: present(signals),
      reason: `Set to ${override.band} by ${override.by}: ${override.reason}`,
    };
  }

  const people = distinct(signals);
  const signalsPresent = present(signals);

  /**
   * No signal at all is `unknown`, never `high`. An unmined node looks
   * identical to a genuinely single-owner one, and reporting the scary answer
   * for "we have not looked yet" is how a risk dashboard trains people to
   * ignore it.
   */
  if (signalsPresent === 0) {
    return {
      band: "unknown",
      distinctPeople: 0,
      signalsPresent: 0,
      reason:
        "Nothing has been mined for this node yet, so there is no evidence either way.",
    };
  }

  if (people.size <= 1) {
    return {
      band: "high",
      distinctPeople: people.size,
      signalsPresent,
      reason:
        signalsPresent === 1
          ? "One person appears, and only one kind of evidence was available — treat as a lead, not a finding."
          : `One person appears across ${signalsPresent} kinds of evidence.`,
    };
  }

  if (people.size === 2) {
    return {
      band: "medium",
      distinctPeople: 2,
      signalsPresent,
      reason: "Two people appear across the available evidence.",
    };
  }

  return {
    band: "low",
    distinctPeople: people.size,
    signalsPresent,
    reason: `${people.size} people appear across ${signalsPresent} kinds of evidence.`,
  };
}

/**
 * One person, three signals, still one person. Identities are normalized so
 * the same human writing commits as `a@x.com` and confirming as `A@X.com`
 * does not read as two people and quietly halve the apparent risk.
 */
function distinct(signals: ConcentrationSignals): Set<string> {
  const all = new Set<string>();
  for (const set of [
    signals.rationaleAuthors,
    signals.artifactAuthors,
    signals.interactors,
  ]) {
    for (const person of set) {
      const normalized = person.trim().toLowerCase();
      if (normalized.length > 0) all.add(normalized);
    }
  }
  return all;
}

function present(signals: ConcentrationSignals): number {
  return [signals.rationaleAuthors, signals.artifactAuthors, signals.interactors].filter(
    (set) => set.size > 0,
  ).length;
}

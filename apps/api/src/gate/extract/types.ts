import type { ChangeDescriptor } from "@sadhak/shared/types";

/**
 * The gate is only as trustworthy as the parser feeding it. The failure mode
 * that kills an account is a **false BLOCK** from over-eager diff
 * interpretation; a missed catch merely costs a save. So extraction is
 * deliberately conservative: parse what we are sure of, and report everything
 * else as honestly not understood — which produces a neutral check, never a
 * failure.
 */
export interface ExtractionResult {
  /** Confidently extracted. */
  changes: ChangeDescriptor[];
  /** Honestly not understood. Never becomes a BLOCK. */
  unknowns: Array<{ file: string; reason: string }>;
}

export function emptyExtraction(): ExtractionResult {
  return { changes: [], unknowns: [] };
}

export function mergeExtractions(...results: ExtractionResult[]): ExtractionResult {
  return {
    changes: results.flatMap((r) => r.changes),
    unknowns: results.flatMap((r) => r.unknowns),
  };
}

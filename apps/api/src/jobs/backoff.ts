/**
 * Pure, in the same no-I/O spirit as sentinel/score.ts, so every threshold is
 * unit testable without a database.
 */

export const MAX_BACKOFF_MS = 30 * 60_000;

/** 30s, 1m, 2m, 4m … capped at 30m, plus 0–25% jitter against thundering herds. */
export function backoffMs(attempt: number, random: () => number = Math.random): number {
  const safeAttempt = Math.max(1, Math.floor(attempt));
  const base = Math.min(30_000 * 2 ** (safeAttempt - 1), MAX_BACKOFF_MS);
  return base + Math.floor(random() * base * 0.25);
}

export type Settle = { state: "queued"; runAfterMs: number } | { state: "dead_letter" };

/**
 * Where a job goes after an attempt. Exhausted attempts dead-letter — never
 * silently dropped, because a job that vanishes is a bug nobody can see.
 */
export function settleAfterFailure(
  attempts: number,
  maxAttempts: number,
  random: () => number = Math.random,
): Settle {
  if (attempts >= maxAttempts) return { state: "dead_letter" };
  return { state: "queued", runAfterMs: backoffMs(attempts, random) };
}

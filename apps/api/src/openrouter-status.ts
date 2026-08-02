import { config } from "./config.js";
import { log } from "./log.js";
import {
  openrouterCreditLimitUsd,
  openrouterCreditRemainingUsd,
  openrouterReachable,
  openrouterUsageUsd,
} from "./metrics.js";

/**
 * The provider's own view of the key, sampled for the metrics endpoint.
 *
 * Everything else in this codebase counts model spend locally, by writing an
 * `llm_usage` row per call. That is only the truth while Sadhak is the sole
 * consumer of the key — a script, a second deployment, or somebody in the
 * OpenRouter playground spends from the same balance and is invisible to it.
 * The local gauge would read healthy with the real allowance gone, which is
 * the failure this closes.
 */

const ENDPOINT = "https://openrouter.ai/api/v1/key";

/**
 * The provider is polled on a timer, not on every scrape.
 *
 * `render()` runs every collector on each Prometheus scrape, and the scrape
 * interval is seconds — hitting a vendor API that often would be thousands of
 * pointless requests a day against an account whose whole problem is a request
 * budget. A minute is far finer than a credit balance moves.
 */
const MIN_POLL_INTERVAL_MS = 60_000;

/**
 * A ceiling, because this runs inside a scrape. `render()` awaits its
 * collectors, so a provider that accepts the connection and never answers
 * would hold the metrics endpoint open until Prometheus itself timed out —
 * turning one slow vendor into a monitoring outage.
 */
const TIMEOUT_MS = 5_000;

interface KeyResponse {
  data?: {
    limit?: number | null;
    limit_remaining?: number | null;
    usage?: number;
    usage_daily?: number;
    usage_weekly?: number;
    usage_monthly?: number;
    is_free_tier?: boolean;
  };
}

let lastPolledAt = 0;

export function openrouterStatusConfigured(): boolean {
  return Boolean(config.OPENROUTER_API_KEY);
}

/**
 * Refreshes the provider gauges, at most once per interval.
 *
 * Never throws. A failure sets `openrouter_reachable` to 0 and leaves the
 * other gauges holding their last values — Prometheus reads an unchanged
 * sample as stale, which is honest, whereas zeroing them would look exactly
 * like a key that had been drained.
 */
export async function refreshOpenrouterStatus(now = Date.now()): Promise<void> {
  if (!config.OPENROUTER_API_KEY) return;
  if (now - lastPolledAt < MIN_POLL_INTERVAL_MS) return;
  lastPolledAt = now;

  try {
    const response = await fetch(ENDPOINT, {
      headers: { authorization: `Bearer ${config.OPENROUTER_API_KEY}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (!response.ok) {
      openrouterReachable.set(0);
      log().warn(
        { event: "openrouter_key_poll_failed", status: response.status },
        "openrouter: key poll returned a non-200",
      );
      return;
    }

    const body = (await response.json()) as KeyResponse;
    const data = body.data;
    if (!data) {
      openrouterReachable.set(0);
      return;
    }

    /**
     * `limit` is null on an uncapped key, and null is not zero — a key with no
     * ceiling has infinite headroom, so reporting 0 would make every
     * remaining-credit panel read as exhausted. Both are published as 0 and
     * the dashboard says what that means, because a gauge cannot carry null.
     */
    openrouterCreditLimitUsd.set(data.limit ?? 0);
    openrouterCreditRemainingUsd.set(data.limit_remaining ?? 0);

    openrouterUsageUsd.set(data.usage ?? 0, { window: "total" });
    openrouterUsageUsd.set(data.usage_daily ?? 0, { window: "daily" });
    openrouterUsageUsd.set(data.usage_weekly ?? 0, { window: "weekly" });
    openrouterUsageUsd.set(data.usage_monthly ?? 0, { window: "monthly" });

    openrouterReachable.set(1);
  } catch (error) {
    openrouterReachable.set(0);
    log().warn(
      {
        event: "openrouter_key_poll_failed",
        err: error instanceof Error ? error.message : String(error),
      },
      "openrouter: key poll failed",
    );
  }
}

/** Test seam — the interval is stateful across calls. */
export const __testing = {
  reset: () => {
    lastPolledAt = 0;
  },
  MIN_POLL_INTERVAL_MS,
};

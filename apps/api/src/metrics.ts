/**
 * A minimal Prometheus registry.
 *
 * Hand-rolled rather than `prom-client`, for the same reason `useQuery` is 40
 * lines rather than TanStack Query: the surface actually needed here is
 * counters and one latency histogram, and a dependency that pulls in a
 * clustered-aggregation layer we will never run is not a saving.
 *
 * Everything is process-local and resets on restart, which is what Prometheus
 * expects of a counter — `rate()` handles the reset. Nothing here is a source
 * of truth; the database is.
 */

type Labels = Record<string, string | number>;

interface Series {
  labels: Labels;
  value: number;
}

class Counter {
  readonly #series = new Map<string, Series>();

  constructor(
    readonly name: string,
    readonly help: string,
  ) {}

  inc(labels: Labels = {}, by = 1): void {
    const key = keyOf(labels);
    const existing = this.#series.get(key);
    if (existing) existing.value += by;
    else this.#series.set(key, { labels, value: by });
  }

  render(): string {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} counter`];
    for (const series of this.#series.values()) {
      lines.push(`${this.name}${renderLabels(series.labels)} ${series.value}`);
    }
    return lines.join("\n");
  }

  reset(): void {
    this.#series.clear();
  }
}

/**
 * A value that goes up and down, and — unlike a counter — is *sampled* rather
 * than accumulated. Set by a collector at scrape time, because the quantity it
 * reports (how much daily quota is left) lives in Postgres, not in a variable
 * this process increments.
 */
class Gauge {
  readonly #series = new Map<string, Series>();

  constructor(
    readonly name: string,
    readonly help: string,
  ) {}

  set(value: number, labels: Labels = {}): void {
    this.#series.set(keyOf(labels), { labels, value });
  }

  render(): string {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} gauge`];
    for (const series of this.#series.values()) {
      lines.push(`${this.name}${renderLabels(series.labels)} ${series.value}`);
    }
    return lines.join("\n");
  }

  reset(): void {
    this.#series.clear();
  }
}

/**
 * Cumulative buckets, as Prometheus defines a histogram: each bucket counts
 * everything at or below its bound. Bounds are chosen around the gate's
 * budget — the interesting question is "how close to 75ms are we", not "how
 * many requests took under a second".
 */
class Histogram {
  /** Milliseconds, and the default because most things measured here are. */
  static readonly BOUNDS = [5, 10, 25, 50, 75, 100, 250, 500, 1000, 2500];

  /**
   * Seconds, for the Reflex SLAs.
   *
   * The millisecond ladder cannot express them: its top bucket is 2500, so a
   * 10-second repair and a 10-minute one both land in `+Inf` and the p95 that
   * the objective is written against is unmeasurable. The bounds straddle the
   * two published numbers — 2s to detect, 10s to repair — so "are we inside
   * the SLA" is a bucket boundary rather than an interpolation between one.
   */
  static readonly SECONDS_BOUNDS = [0.5, 1, 2, 5, 10, 30, 60, 300, 900, 3600];

  readonly #series = new Map<string, { labels: Labels; counts: number[]; sum: number }>();
  readonly #bounds: readonly number[];

  constructor(
    readonly name: string,
    readonly help: string,
    bounds: readonly number[] = Histogram.BOUNDS,
  ) {
    this.#bounds = bounds;
  }

  observe(value: number, labels: Labels = {}): void {
    const key = keyOf(labels);
    let series = this.#series.get(key);
    if (!series) {
      series = { labels, counts: new Array(this.#bounds.length + 1).fill(0), sum: 0 };
      this.#series.set(key, series);
    }
    series.sum += value;
    const index = this.#bounds.findIndex((bound) => value <= bound);
    const slot = index === -1 ? this.#bounds.length : index;
    for (let i = slot; i < series.counts.length; i++) {
      const current = series.counts[i];
      if (current !== undefined) series.counts[i] = current + 1;
    }
  }

  render(): string {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} histogram`];
    for (const series of this.#series.values()) {
      this.#bounds.forEach((bound, i) => {
        const labels = { ...series.labels, le: String(bound) };
        lines.push(`${this.name}_bucket${renderLabels(labels)} ${series.counts[i] ?? 0}`);
      });
      const total = series.counts.at(-1) ?? 0;
      lines.push(
        `${this.name}_bucket${renderLabels({ ...series.labels, le: "+Inf" })} ${total}`,
      );
      lines.push(`${this.name}_sum${renderLabels(series.labels)} ${series.sum}`);
      lines.push(`${this.name}_count${renderLabels(series.labels)} ${total}`);
    }
    return lines.join("\n");
  }

  reset(): void {
    this.#series.clear();
  }
}

function keyOf(labels: Labels): string {
  return Object.entries(labels)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join(",");
}

/**
 * Sorted, so the exposition is byte-identical regardless of which call site
 * happened to create the series first — otherwise a diff between two scrapes
 * shows changes that are only key ordering. `le` sorts last by convention,
 * where every Prometheus example puts it.
 */
function renderLabels(labels: Labels): string {
  const entries = Object.entries(labels).sort(([a], [b]) => {
    if (a === "le") return 1;
    if (b === "le") return -1;
    return a.localeCompare(b);
  });
  if (entries.length === 0) return "";
  const rendered = entries
    .map(([k, v]) => `${k}="${String(v).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`)
    .join(",");
  return `{${rendered}}`;
}

/* ------------------------------------------------------------- registry */

export const httpRequests = new Counter(
  "sadhak_http_requests_total",
  "HTTP requests by method, route and status class.",
);

export const httpDuration = new Histogram(
  "sadhak_http_request_duration_ms",
  "HTTP request duration in milliseconds.",
);

/**
 * The counters Plan 13.3 deferred to here. A sustained rise in `limited` on the
 * ip tier is either a misconfigured client or someone probing, which are the
 * two things worth an alert.
 */
export const rateLimitDecisions = new Counter(
  "sadhak_rate_limit_decisions_total",
  "Rate limit decisions by tier and outcome.",
);

export const llmCalls = new Counter(
  "sadhak_llm_calls_total",
  "Model provider calls by tier, caller and outcome.",
);

export const jobsProcessed = new Counter(
  "sadhak_jobs_total",
  "Background jobs by kind and outcome.",
);

/**
 * The short-circuit ratio is a product claim (~99% of ticks cost nothing) and
 * a quota-feasibility claim. Measured rather than asserted: if it falls below
 * ~95%, the drift loop is over budget in model requests before it is over
 * budget in dollars.
 */
export const driftTicks = new Counter(
  "sadhak_drift_ticks_total",
  "Drift gate ticks by outcome — started vs short_circuited.",
);

export const driftFindingsOpened = new Counter(
  "sadhak_drift_findings_total",
  "Drift findings by outcome — open vs auto_dismissed by a prior judgment.",
);

/**
 * Triage outcomes. `unsure` and `unavailable` are counted separately on
 * purpose: the first is the agent doing its job, the second is the agent not
 * getting to do it, and conflating them would hide a broken model path behind
 * a healthy-looking rate of honest uncertainty.
 */
/**
 * The single most important number in this file.
 *
 * When the free tier's daily request cap is spent, nothing breaks in a way any
 * other alert can see: verdicts keep serving (they never touch a model),
 * latency does not move, no 5xx appears, and the SLOs stay green. The agents
 * have simply stopped. This gauge is the only signal that says so, which is
 * why the rule reading it pages rather than warns.
 */
export const llmDailyQuotaRemaining = new Gauge(
  "sadhak_llm_daily_quota_remaining_ratio",
  "Fraction of the account-wide daily LLM request cap still unspent (0-1)",
);

/**
 * How full the per-minute window is, 0-1. The 20 rpm ceiling is account-wide
 * across every concurrent agent loop, so saturation here is a fleet condition
 * and the response is to reduce concurrency — never to add retries.
 */
export const llmRpmWindowUsed = new Gauge(
  "sadhak_llm_rpm_window_used_ratio",
  "Fraction of the per-minute LLM request allowance used in the current window (0-1)",
);

export const driftTriage = new Counter(
  "sadhak_drift_triage_total",
  "Drift triage outcomes — benign, real, unsure, unavailable.",
);

/* ------------------------------------------------- sentinel and reflex */

/**
 * What the gate actually decided.
 *
 * The latency of a verdict was already measured and its *outcome* was not,
 * which left the two questions a reviewer asks about a gate — is it fast, and
 * is it saying anything — with only one answer. A gate that has quietly
 * stopped blocking is indistinguishable from a healthy one on latency alone.
 */
export const verdictsIssued = new Counter(
  "sadhak_verdicts_total",
  "Verdicts by decision — APPROVE, WARN, BLOCK.",
);

/**
 * Graph traversal plus scoring, which is the number the ~40ms claim is about.
 *
 * Deliberately not the HTTP duration. That includes auth, serialisation and
 * the network, so publishing it as the engine's latency would overstate the
 * cost of the engine and hide a traversal regression behind request overhead.
 */
export const verdictCompute = new Histogram(
  "sadhak_verdict_compute_ms",
  "Blast-radius traversal and scoring time in milliseconds, excluding HTTP overhead.",
);

/**
 * Vendor change → Sadhak noticed. The `detect_path` label is not decoration:
 * push and poll have different latencies by construction, and averaging them
 * produces a number describing neither.
 *
 * Only observed when the vendor supplied a change timestamp. Where it did not,
 * the interval would be measured from a clock we invented, and a fabricated
 * SLA reading is worse than a missing one.
 */
export const reflexDetectSeconds = new Histogram(
  "sadhak_reflex_detect_seconds",
  "Seconds between a change happening upstream and Sadhak detecting it.",
  Histogram.SECONDS_BOUNDS,
);

/** Detected → reverted, which is the repair half of the same objective. */
export const reflexRepairSeconds = new Histogram(
  "sadhak_reflex_repair_seconds",
  "Seconds between detecting a change and completing its revert.",
  Histogram.SECONDS_BOUNDS,
);

/* ----------------------------------------------------- historian engine */

/**
 * Embedding throughput, labelled by provider.
 *
 * The label is the point: `local` runs bge-small on this CPU and `openrouter`
 * is a network round trip, so they are different distributions entirely. One
 * unlabelled series would be bimodal and its p95 would track whichever
 * provider happened to be busier.
 */
export const embeddingDuration = new Histogram(
  "sadhak_embedding_duration_ms",
  "Time to embed one batch of windows, in milliseconds, by provider.",
);

export const embeddingWindows = new Counter(
  "sadhak_embedding_windows_total",
  "Text windows embedded, by provider — the unit the model actually charges for.",
);

/**
 * Tokens, which are what the budget is denominated in.
 *
 * `sadhak_llm_calls_total` counts requests, and requests are the wrong unit
 * for cost: one agent loop with a large context can outspend a hundred small
 * calls while looking identical on a call-rate graph.
 */
export const llmTokens = new Counter(
  "sadhak_llm_tokens_total",
  "Model tokens by tier, caller and direction — prompt vs completion.",
);

/**
 * What we believe we have spent, from our own `llm_usage` rows.
 *
 * A gauge rather than a counter because it is sampled from Postgres at scrape
 * time, not incremented here. The same reasoning as the daily quota: several
 * processes make model calls, so anything counted in memory is wrong the
 * moment a second worker runs.
 */
export const llmSpendUsd = new Gauge(
  "sadhak_llm_spend_usd",
  "Model spend in USD from our own accounting, by window.",
);

/* ------------------------------------------------------ openrouter, live */

/**
 * The provider's own numbers, which are the authoritative ones.
 *
 * Everything above is Sadhak's bookkeeping, and it is only correct while
 * Sadhak is the sole consumer of the key. A script, another app, or the
 * OpenRouter playground spending on the same account is invisible to it — the
 * local gauge would read healthy with the real allowance gone. These come from
 * `GET /api/v1/key`, so they see that spend too.
 */
export const openrouterCreditRemainingUsd = new Gauge(
  "sadhak_openrouter_credit_remaining_usd",
  "Credit left on the OpenRouter key, in USD, as the provider reports it.",
);

export const openrouterCreditLimitUsd = new Gauge(
  "sadhak_openrouter_credit_limit_usd",
  "Credit limit configured on the OpenRouter key, in USD. Zero when uncapped.",
);

export const openrouterUsageUsd = new Gauge(
  "sadhak_openrouter_usage_usd",
  "Spend on the OpenRouter key by window — daily, weekly, monthly, total.",
);

/**
 * Whether the last poll of the provider succeeded.
 *
 * Without this a provider outage and a healthy-but-idle key look identical:
 * the gauges above simply stop moving. This is the panel that distinguishes
 * "nothing spent" from "we have no idea what was spent".
 */
export const openrouterReachable = new Gauge(
  "sadhak_openrouter_reachable",
  "1 when the last OpenRouter key poll succeeded, 0 when it failed.",
);

const ALL = [
  httpRequests,
  httpDuration,
  rateLimitDecisions,
  llmCalls,
  jobsProcessed,
  driftTicks,
  driftFindingsOpened,
  driftTriage,
  llmDailyQuotaRemaining,
  llmRpmWindowUsed,
  verdictsIssued,
  verdictCompute,
  reflexDetectSeconds,
  reflexRepairSeconds,
  embeddingDuration,
  embeddingWindows,
  llmTokens,
  llmSpendUsd,
  openrouterCreditRemainingUsd,
  openrouterCreditLimitUsd,
  openrouterUsageUsd,
  openrouterReachable,
];

/**
 * Sampled at scrape time rather than pushed.
 *
 * Registered by `index.ts` so this module keeps no imports of its own — a
 * metrics registry that reaches into the database would be a cycle, and a
 * collector that throws must not take the scrape down with it.
 */
type Collector = () => Promise<void>;
const collectors: Collector[] = [];

export function registerCollector(collect: Collector): void {
  collectors.push(collect);
}

/**
 * The full exposition, in Prometheus text format.
 *
 * A failing collector leaves its gauge at the last value it held rather than
 * failing the scrape. Prometheus reads a stale sample as stale — the `up`
 * metric and the staleness of the series both say so — whereas a 500 here
 * blinds every rule at once, including the ones that would have explained why.
 */
export async function render(): Promise<string> {
  await Promise.allSettled(collectors.map((collect) => collect()));
  return `${ALL.map((metric) => metric.render()).join("\n\n")}\n`;
}

/** Test seam. */
export function resetMetrics(): void {
  for (const metric of ALL) metric.reset();
  collectors.length = 0;
}

/**
 * Route label, deliberately coarse. The raw path would make every node id its
 * own time series, and a metrics endpoint that grows without bound is how a
 * Prometheus instance falls over.
 */
export function routeLabel(path: string): string {
  return path
    .split("/")
    .map((segment) => (/^\d+$/.test(segment) ? ":id" : segment))
    .join("/");
}

/** 2xx, 4xx, 5xx — the granularity alerts are actually written against. */
export function statusClass(status: number): string {
  return `${Math.floor(status / 100)}xx`;
}

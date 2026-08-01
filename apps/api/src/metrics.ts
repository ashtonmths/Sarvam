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
 * Cumulative buckets, as Prometheus defines a histogram: each bucket counts
 * everything at or below its bound. Bounds are chosen around the gate's
 * budget — the interesting question is "how close to 75ms are we", not "how
 * many requests took under a second".
 */
class Histogram {
  static readonly BOUNDS = [5, 10, 25, 50, 75, 100, 250, 500, 1000, 2500];
  readonly #series = new Map<string, { labels: Labels; counts: number[]; sum: number }>();

  constructor(
    readonly name: string,
    readonly help: string,
  ) {}

  observe(valueMs: number, labels: Labels = {}): void {
    const key = keyOf(labels);
    let series = this.#series.get(key);
    if (!series) {
      series = { labels, counts: new Array(Histogram.BOUNDS.length + 1).fill(0), sum: 0 };
      this.#series.set(key, series);
    }
    series.sum += valueMs;
    const index = Histogram.BOUNDS.findIndex((bound) => valueMs <= bound);
    const slot = index === -1 ? Histogram.BOUNDS.length : index;
    for (let i = slot; i < series.counts.length; i++) {
      const current = series.counts[i];
      if (current !== undefined) series.counts[i] = current + 1;
    }
  }

  render(): string {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} histogram`];
    for (const series of this.#series.values()) {
      Histogram.BOUNDS.forEach((bound, i) => {
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
export const driftTriage = new Counter(
  "sadhak_drift_triage_total",
  "Drift triage outcomes — benign, real, unsure, unavailable.",
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
];

/** The full exposition, in Prometheus text format. */
export function render(): string {
  return `${ALL.map((metric) => metric.render()).join("\n\n")}\n`;
}

/** Test seam. */
export function resetMetrics(): void {
  for (const metric of ALL) metric.reset();
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

import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import {
  httpDuration,
  httpRequests,
  rateLimitDecisions,
  render,
  resetMetrics,
  routeLabel,
  statusClass,
} from "./metrics.js";

beforeEach(() => {
  resetMetrics();
});

describe("routeLabel", () => {
  it("collapses numeric ids so cardinality stays bounded", async () => {
    // A label per node id would make Prometheus fall over on a real graph.
    expect(routeLabel("/api/graph/nodes/4821")).toBe("/api/graph/nodes/:id");
    expect(routeLabel("/api/orgs/7/verdicts/12")).toBe("/api/orgs/:id/verdicts/:id");
  });

  it("leaves non-numeric segments alone", async () => {
    expect(routeLabel("/api/graph/stats")).toBe("/api/graph/stats");
    expect(routeLabel("/webhooks/github")).toBe("/webhooks/github");
  });
});

describe("statusClass", () => {
  it.each([
    [200, "2xx"],
    [204, "2xx"],
    [404, "4xx"],
    [429, "4xx"],
    [500, "5xx"],
    [503, "5xx"],
  ])("maps %i to %s", (status, expected) => {
    expect(statusClass(status)).toBe(expected);
  });
});

describe("counters", () => {
  it("accumulates per label set, not globally", async () => {
    httpRequests.inc({ method: "GET", route: "/health", status: "2xx" });
    httpRequests.inc({ method: "GET", route: "/health", status: "2xx" });
    httpRequests.inc({ method: "POST", route: "/gate", status: "4xx" });

    const output = await render();

    expect(output).toContain(
      'sadhak_http_requests_total{method="GET",route="/health",status="2xx"} 2',
    );
    expect(output).toContain(
      'sadhak_http_requests_total{method="POST",route="/gate",status="4xx"} 1',
    );
  });

  it("treats label order as irrelevant to identity", async () => {
    rateLimitDecisions.inc({ tier: "ip", outcome: "allowed" });
    rateLimitDecisions.inc({ outcome: "allowed", tier: "ip" });

    expect(await render()).toContain(
      'sadhak_rate_limit_decisions_total{outcome="allowed",tier="ip"} 2',
    );
  });

  it("records allowed and limited separately", async () => {
    rateLimitDecisions.inc({ tier: "auth", outcome: "allowed" });
    rateLimitDecisions.inc({ tier: "auth", outcome: "limited" });
    rateLimitDecisions.inc({ tier: "auth", outcome: "limited" });

    const output = await render();

    expect(output).toContain('outcome="allowed",tier="auth"} 1');
    expect(output).toContain('outcome="limited",tier="auth"} 2');
  });
});

describe("histogram", () => {
  it("buckets cumulatively, as prometheus defines it", async () => {
    httpDuration.observe(3, { route: "/gate" });
    httpDuration.observe(30, { route: "/gate" });
    httpDuration.observe(90, { route: "/gate" });

    const output = await render();

    // 3ms falls in every bucket from 5 upward.
    expect(output).toContain(
      'sadhak_http_request_duration_ms_bucket{route="/gate",le="5"} 1',
    );
    expect(output).toContain(
      'sadhak_http_request_duration_ms_bucket{route="/gate",le="50"} 2',
    );
    expect(output).toContain(
      'sadhak_http_request_duration_ms_bucket{route="/gate",le="100"} 3',
    );
    expect(output).toContain(
      'sadhak_http_request_duration_ms_bucket{route="/gate",le="+Inf"} 3',
    );
    expect(output).toContain('sadhak_http_request_duration_ms_sum{route="/gate"} 123');
    expect(output).toContain('sadhak_http_request_duration_ms_count{route="/gate"} 3');
  });

  it("counts an observation past the last bound only in +Inf", async () => {
    httpDuration.observe(9_999, { route: "/slow" });

    const output = await render();

    expect(output).toContain(
      'sadhak_http_request_duration_ms_bucket{route="/slow",le="2500"} 0',
    );
    expect(output).toContain(
      'sadhak_http_request_duration_ms_bucket{route="/slow",le="+Inf"} 1',
    );
  });
});

describe("published docs", () => {
  it("documents every metric this process exposes", async () => {
    // Same guard as connector scopes and .env.example: a metric nobody
    // documented is a metric nobody can alert on, because they never learn it
    // exists.
    const doc = readFileSync(
      new URL("../../../docs/OBSERVABILITY.md", import.meta.url),
      "utf8",
    );

    const exposition = await render();
    const exposed = [...exposition.matchAll(/^# TYPE (\S+) /gm)].map((m) => m[1]);
    expect(exposed.length).toBeGreaterThan(0);

    for (const name of exposed) {
      expect(doc, `${name} is exposed but absent from docs/OBSERVABILITY.md`).toContain(
        name,
      );
    }
  });
});

describe("exposition format", () => {
  it("emits HELP and TYPE for every metric", async () => {
    const output = await render();

    for (const name of [
      "sadhak_http_requests_total",
      "sadhak_http_request_duration_ms",
      "sadhak_rate_limit_decisions_total",
      "sadhak_llm_calls_total",
      "sadhak_jobs_total",
    ]) {
      expect(output).toContain(`# HELP ${name} `);
      expect(output).toContain(`# TYPE ${name} `);
    }
  });

  it("ends with a newline, which the text format requires", async () => {
    expect((await render()).endsWith("\n")).toBe(true);
  });

  it("escapes quotes in a label value rather than emitting broken output", async () => {
    httpRequests.inc({ method: 'GET"evil', route: "/x", status: "2xx" });

    expect(await render()).toContain('method="GET\\"evil"');
  });
});

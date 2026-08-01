import { context, SpanStatusCode, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { currentTraceId, requestSpan, traced } from "./tracing.js";

/**
 * Tracing, against a real tracer rather than a mock.
 *
 * A hand-rolled fake would pass whether or not the spans are actually well
 * formed, which is the only thing worth checking here — the parent/child
 * relationship and the trace id reaching a log line are properties of the
 * OpenTelemetry API, not of our wrapper. So these register a real provider
 * with an in-memory exporter and read back what a collector would receive.
 */

const exporter = new InMemorySpanExporter();
const provider = new BasicTracerProvider({
  spanProcessors: [new SimpleSpanProcessor(exporter)],
});
trace.setGlobalTracerProvider(provider);

// Registered because `NodeSDK` registers it in production, and without it the
// tests here are not testing the same thing the service does. A tracer
// provider on its own does not make a started span *active*: `startActiveSpan`
// still runs the callback, but `getActiveSpan()` inside it returns undefined,
// so nothing nests and no log line ever gets a trace id. Leaving it out made
// three of these tests fail against code that works, which is worth a comment
// rather than a second discovery later.
context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());

beforeEach(() => exporter.reset());
afterAll(async () => {
  await provider.shutdown();
});

describe("traced", () => {
  it("returns the wrapped value and ends the span", async () => {
    const result = await traced("op", { "a.attr": 1 }, async () => "value");

    expect(result).toBe("value");
    const [span] = exporter.getFinishedSpans();
    expect(span?.name).toBe("op");
    expect(span?.attributes["a.attr"]).toBe(1);
    expect(span?.status.code).toBe(SpanStatusCode.OK);
  });

  it("records the failure and rethrows it", async () => {
    const boom = new Error("nope");

    await expect(traced("op", {}, () => Promise.reject(boom))).rejects.toThrow("nope");

    const [span] = exporter.getFinishedSpans();
    expect(span?.status.code).toBe(SpanStatusCode.ERROR);
    expect(span?.status.message).toBe("nope");
    // A span that swallowed the error it describes would be worse than none.
    expect(span?.events.map((event) => event.name)).toContain("exception");
  });

  it("ends the span even when the body throws", async () => {
    await expect(
      traced("op", {}, () => Promise.reject(new Error("x"))),
    ).rejects.toThrow();
    expect(exporter.getFinishedSpans()).toHaveLength(1);
  });
});

describe("requestSpan", () => {
  it("names the span from the method and route", async () => {
    await requestSpan("POST", "/api/verdicts", async () => undefined);

    const [span] = exporter.getFinishedSpans();
    expect(span?.name).toBe("POST /api/verdicts");
    expect(span?.attributes["http.route"]).toBe("/api/verdicts");
    expect(span?.attributes["http.request.method"]).toBe("POST");
  });

  it("parents the work done inside it", async () => {
    // The property the whole correlation story rests on: a verdict span has to
    // hang off the request that asked for it, or a trace is a flat list of
    // unrelated operations.
    await requestSpan("POST", "/api/verdicts", () =>
      traced("sadhak.verdict", {}, async () => undefined),
    );

    const spans = exporter.getFinishedSpans();
    const request = spans.find((span) => span.name === "POST /api/verdicts");
    const verdict = spans.find((span) => span.name === "sadhak.verdict");

    expect(verdict?.parentSpanContext?.spanId).toBe(request?.spanContext().spanId);
    expect(verdict?.spanContext().traceId).toBe(request?.spanContext().traceId);
  });
});

describe("currentTraceId", () => {
  it("is the id of the span in scope", async () => {
    let seen: string | undefined;
    await requestSpan("GET", "/api/graph/nodes", async () => {
      seen = currentTraceId();
    });

    const [span] = exporter.getFinishedSpans();
    expect(seen).toBe(span?.spanContext().traceId);
  });

  it("survives an await, so a log line written late still correlates", async () => {
    let seen: string | undefined;
    await requestSpan("GET", "/api/graph/nodes", async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      seen = currentTraceId();
    });

    expect(seen).toBe(exporter.getFinishedSpans()[0]?.spanContext().traceId);
  });

  it("is undefined with no span in scope", () => {
    // What every log line looks like with tracing switched off, which is the
    // default. `log()` must not stamp a `traceId` field in that case.
    expect(currentTraceId()).toBeUndefined();
  });
});

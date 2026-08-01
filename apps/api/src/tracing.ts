import { type Span, SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { NodeSDK } from "@opentelemetry/sdk-node";
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
} from "@opentelemetry/semantic-conventions";
import { config } from "./config.js";

/**
 * Tracing, off unless something is listening.
 *
 * There is no collector deployed yet. That is deliberately not a reason to skip
 * the instrumentation: spans are code, an exporter target is configuration, and
 * writing the spans now means traces flow the day a collector exists rather
 * than starting a fresh project then. What it *is* a reason for is refusing to
 * start an SDK that would batch spans into a socket nobody is holding — so
 * `OTEL_EXPORTER_OTLP_ENDPOINT` being unset means the SDK never starts and
 * every span below becomes a no-op the runtime discards.
 *
 * The span names double as the SLO vocabulary, so a latency
 * objective and the thing that measures it cannot drift into describing
 * different operations.
 */

const NAME = "sadhak-api";

let started = false;

export function startTracing(): void {
  if (started || !config.OTEL_EXPORTER_OTLP_ENDPOINT) return;

  const sdk = new NodeSDK({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: NAME,
      [ATTR_SERVICE_VERSION]: config.GIT_SHA ?? "dev",
    }),
    traceExporter: new OTLPTraceExporter({
      url: `${config.OTEL_EXPORTER_OTLP_ENDPOINT}/v1/traces`,
    }),
    // No auto-instrumentation. Not a preference — it does not work here.
    //
    // The service runs as ESM under tsx, and `import` bindings are resolved
    // before any statement in the entrypoint executes. By the time
    // `startTracing()` runs, `node:http` has been imported and the server holds
    // its own reference, so `instrumentation-http` patches a module object
    // nobody consults. Verified rather than assumed: with it installed, a real
    // signin and a real verdict produced exactly zero HTTP spans. Making it
    // work needs a loader hook and a `--import` preload, which is a build-time
    // contract for something `requestSpan` below already does correctly and
    // with better names.
    //
    // Database spans are the notable gap. The driver is postgres.js, and
    // `instrumentation-pg` patches node-postgres, which is never loaded here.
    // It also drags in `@types/pg`, which changes drizzle's optional peer set
    // and splits apps/api and packages/shared onto two drizzle instances with
    // incompatible table types. postgres.js exposes a `debug` hook that fires
    // when a query is sent but nothing when it resolves, so there is no honest
    // way to time a query through it. Query timing stays in
    // `pg_stat_statements` until an instrumentation exists.
  });

  sdk.start();
  started = true;

  // Flush on the way out, inside the drain window, so the spans describing a
  // shutdown are not the ones lost to it.
  const flush = () => {
    void sdk.shutdown().catch(() => undefined);
  };
  process.once("SIGTERM", flush);
  process.once("SIGINT", flush);
}

const tracer = trace.getTracer(NAME);

/**
 * Wraps an operation in a span. A no-op when tracing is off, so call sites do
 * not branch on whether a collector exists.
 *
 * Errors are recorded and rethrown: a span that swallowed the failure it was
 * describing would be worse than no span.
 */
export async function traced<T>(
  name: string,
  attributes: Record<string, string | number | boolean>,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  return tracer.startActiveSpan(name, { attributes }, async (span) => {
    try {
      const result = await fn(span);
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (error) {
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: error instanceof Error ? error.message : String(error),
      });
      if (error instanceof Error) span.recordException(error);
      throw error;
    } finally {
      span.end();
    }
  });
}

/**
 * The current trace id, for log correlation. Without this a trace and the log
 * lines describing the same request live in two systems with no way to join
 * them, which is the failure that makes people stop opening the tracing UI.
 */
export function currentTraceId(): string | undefined {
  const context = trace.getActiveSpan()?.spanContext();
  return context?.traceId;
}

/**
 * The server span for one request, opened by the `requestId` middleware so
 * everything downstream runs inside it — including `log()`, which reads the
 * active span to stamp lines with a trace id.
 *
 * Named from `routeLabel`, the same function the Prometheus route label uses.
 * That is deliberate on two counts: a span named `/api/verdicts/:id` groups,
 * where one carrying a real uuid makes every request its own unique name and
 * turns the trace UI into a list; and a latency spike in a dashboard and the
 * traces explaining it are then filed under a name that matches exactly.
 */
export async function requestSpan<T>(
  method: string,
  route: string,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  return tracer.startActiveSpan(
    `${method} ${route}`,
    {
      kind: SpanKind.SERVER,
      attributes: { "http.request.method": method, "http.route": route },
    },
    async (span) => {
      try {
        return await fn(span);
      } catch (error) {
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: error instanceof Error ? error.message : String(error),
        });
        if (error instanceof Error) span.recordException(error);
        throw error;
      } finally {
        span.end();
      }
    },
  );
}

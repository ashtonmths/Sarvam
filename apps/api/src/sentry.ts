import * as Sentry from "@sentry/node";
import { config } from "./config.js";
import { AppError, UpstreamError, UserError } from "./errors.js";
import { REDACTED } from "./log.js";

/**
 * Error tracking, off unless a DSN is configured.
 *
 * Same posture as tracing: the integration is code, the destination is
 * configuration, and `SENTRY_DSN` being unset means the SDK never initializes
 * and every capture below is a no-op. Sentry being absent must never affect
 * boot, in the same spirit as the LLM keys.
 *
 * **Errors only, no traces.** `tracesSampleRate: 0` is deliberate rather than
 * an oversight — Tempo owns tracing, and paying a second vendor to sample the
 * same spans buys nothing but a second place to look.
 *
 * **Alert-source discipline.** Sentry notifies on a *new issue in a release*
 * and nothing else. Rate and threshold paging belongs to Alertmanager alone.
 * Two independent pagers firing for one incident is how a team learns to
 * ignore both.
 */

let started = false;

/**
 * The bare key names from the log redaction list. Pino's paths use its own
 * syntax (`*.token`, `req.headers['x-api-key']`); what matters here is the
 * final segment, since the scrub below walks the object rather than matching
 * paths.
 */
const SECRET_KEYS = new Set(
  REDACTED.map((path) => {
    const last = path.split(".").pop() ?? path;
    return last.replace(/\[['"]?|['"]?\]/g, "").toLowerCase();
  }).filter((key) => key !== "*"),
);

/** Walks a value and replaces anything under a secret-looking key. */
function scrub(value: unknown, depth = 0): unknown {
  if (depth > 6 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => scrub(item, depth + 1));

  const out: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    out[key] = SECRET_KEYS.has(key.toLowerCase())
      ? "[Redacted]"
      : scrub(nested, depth + 1);
  }
  return out;
}

/**
 * Test seam. The scrub is the security-relevant half of this module and it is
 * a pure function, so it is worth testing directly rather than through a
 * `beforeSend` that only runs when a DSN exists.
 */
export const __scrubForTest = (value: unknown): unknown => scrub(value);

export function startErrorTracking(): void {
  if (started || !config.SENTRY_DSN) return;

  Sentry.init({
    dsn: config.SENTRY_DSN,
    environment: config.NODE_ENV,
    // Matches the GHCR image tag, so "which deploy introduced this" is a join
    // rather than an investigation.
    release: config.GIT_SHA ?? "dev",
    tracesSampleRate: 0,
    // The api runs TypeScript directly under tsx, so stack traces already
    // point at real .ts lines and there are no source maps to upload.
    beforeSend(event) {
      // Request bodies go entirely. They are the one place a customer payload
      // could reach an error report, and no debugging value justifies that
      // against the structure-never-payloads promise.
      if (event.request) {
        event.request.data = undefined;
        event.request.cookies = undefined;
        if (event.request.headers) {
          event.request.headers = scrub(event.request.headers) as Record<string, string>;
        }
      }
      if (event.extra) event.extra = scrub(event.extra) as Record<string, unknown>;
      if (event.contexts) {
        event.contexts = scrub(event.contexts) as typeof event.contexts;
      }
      return event;
    },
  });

  started = true;
}

/**
 * Reports an error, if it is ours to report.
 *
 * The taxonomy does the filtering, which is the point of having one:
 *
 *   `UserError` and everything under it   never reported. A 4xx is customer
 *                                         behaviour, not our defect, and an
 *                                         inbox full of validation failures is
 *                                         an inbox nobody opens.
 *   `UpstreamError`                       warning, tagged by connector. Their
 *                                         outage, our symptom — worth seeing
 *                                         the trend, not worth waking for.
 *   everything else                       error. `SystemError` and anything
 *                                         unrecognised are the 5xx family.
 */
export function captureError(
  error: unknown,
  tags: { requestId?: string; orgId?: number | string; route?: string } = {},
): void {
  if (!started) return;
  if (error instanceof UserError) return;

  const level = error instanceof UpstreamError ? "warning" : "error";

  Sentry.withScope((scope) => {
    scope.setLevel(level);
    if (tags.requestId) scope.setTag("request_id", tags.requestId);
    if (tags.orgId !== undefined) scope.setTag("org_id", String(tags.orgId));
    if (tags.route) scope.setTag("route", tags.route);
    if (error instanceof AppError) {
      scope.setTag("error_type", error.type);
      // `meta` is the error's own structured context. Scrubbed, because a
      // connector error is exactly the kind that carries a token in its meta.
      if (error.meta)
        scope.setContext("meta", scrub(error.meta) as Record<string, unknown>);
    }
    Sentry.captureException(error);
  });
}

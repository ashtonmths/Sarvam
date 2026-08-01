import * as Sentry from "@sentry/nextjs";

/**
 * Browser error capture, off unless a DSN is set.
 *
 * Errors only — `tracesSampleRate: 0`. Tempo owns tracing on the server side
 * and the browser has nothing to add to a trace that the server span does not
 * already carry.
 *
 * Note the CSP: `next.config.mjs` derives Sentry's ingest origin from this
 * same DSN and adds it to `connect-src`. Without that the browser blocks every
 * report and nothing anywhere says so.
 */
Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  enabled: Boolean(process.env.NEXT_PUBLIC_SENTRY_DSN),
  release: process.env.NEXT_PUBLIC_GIT_SHA ?? "dev",
  tracesSampleRate: 0,
  // No session replay: it would record the graph a customer is looking at,
  // which is precisely the data the privacy page promises stays theirs.
  replaysSessionSampleRate: 0,
  replaysOnErrorSampleRate: 0,
});

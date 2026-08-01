import * as Sentry from "@sentry/nextjs";

/**
 * Next's server-side init hook.
 *
 * Without this file the server and edge Sentry configs are never loaded and
 * only browser errors are reported — the build warns about it, which is how
 * this was caught, but a warning in a CI log is not a thing anyone reads twice.
 *
 * The dynamic imports are required: the runtime is only known at call time, and
 * importing the Node config into the edge runtime fails the build.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("./sentry.server.config");
  }
  if (process.env.NEXT_RUNTIME === "edge") {
    await import("./sentry.edge.config");
  }
}

/**
 * Server-side render errors. Next calls this for anything thrown in a server
 * component or route handler, which the SDK cannot otherwise see.
 */
export const onRequestError = Sentry.captureRequestError;

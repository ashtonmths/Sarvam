import type { Context, ErrorHandler, NotFoundHandler } from "hono";
import { ZodError } from "zod";
import { AppError, RateLimitedError } from "../errors.js";
import { log, withLogContext } from "../log.js";
import { httpDuration, httpRequests, routeLabel, statusClass } from "../metrics.js";

/**
 * One error shape for the whole API (RFC 9457 problem details), enforced by a
 * single `app.onError`. Route handlers throw typed errors; they never
 * hand-build an error response.
 */

const BASE_TYPE_URI = "https://sadhak.online/errors";

export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  detail?: string;
  instance: string;
  requestId: string;
  errors?: Record<string, string[]>;
}

function requestIdOf(c: Context): string {
  return c.get("requestId") ?? c.res.headers.get("X-Request-Id") ?? "unknown";
}

function problem(c: Context, body: ProblemDetails) {
  // The content type is part of the RFC 9457 contract, and `c.json` sets its
  // own — so it has to be passed in rather than set beforehand, or every
  // problem response goes out as plain application/json.
  return c.body(JSON.stringify(body), body.status as 400, {
    "Content-Type": "application/problem+json",
  });
}

/**
 * Mints or honors `X-Request-Id`, echoes it on every response, and opens the
 * ambient log context so anything logging below this — however many frames
 * down — carries the same id without being handed a logger.
 */
export async function requestId(c: Context, next: () => Promise<void>) {
  const inbound = c.req.header("X-Request-Id");
  const id = inbound && inbound.length <= 200 ? inbound : crypto.randomUUID();
  c.set("requestId", id);
  c.header("X-Request-Id", id);
  await withLogContext({ requestId: id }, () => next());
}

/**
 * One line per request, after it finishes, at a level that reflects what
 * happened. Health checks are logged at debug: Dokploy probes every few
 * seconds and would otherwise be the overwhelming majority of production log
 * volume, hiding everything worth reading.
 */
export async function requestLog(c: Context, next: () => Promise<void>) {
  const startedAt = performance.now();
  try {
    await next();
  } finally {
    const durationMs = Math.round((performance.now() - startedAt) * 10) / 10;
    const status = c.res.status;
    const route = routeLabel(c.req.path);

    httpRequests.inc({ method: c.req.method, route, status: statusClass(status) });
    httpDuration.observe(durationMs, { route });

    const fields = {
      event: "http_request",
      method: c.req.method,
      path: c.req.path,
      status,
      durationMs,
    };

    if (c.req.path === "/health") log().debug(fields);
    else if (status >= 500) log().error(fields);
    else if (status >= 400) log().warn(fields);
    else log().info(fields);
  }
}

export const onError: ErrorHandler = (err, c) => {
  const requestId = requestIdOf(c);
  const instance = new URL(c.req.url).pathname;

  if (err instanceof ZodError) {
    return problem(c, {
      type: `${BASE_TYPE_URI}/validation`,
      title: "Invalid request",
      status: 400,
      detail: "One or more fields failed validation.",
      instance,
      requestId,
      errors: err.flatten().fieldErrors as Record<string, string[]>,
    });
  }

  if (err instanceof AppError) {
    if (err instanceof RateLimitedError) {
      c.header("Retry-After", String(err.retryAfterSeconds));
    }
    // A non-exposed error's detail is logged, never serialized.
    if (!err.expose) {
      log().error({ event: "app_error", name: err.name, meta: err.meta }, err.message);
    }
    return problem(c, {
      type: `${BASE_TYPE_URI}/${err.type}`,
      title: err.expose ? err.message : "Internal server error",
      status: err.status,
      ...(err.expose ? { detail: err.message } : {}),
      instance,
      requestId,
    });
  }

  log().error({ event: "unhandled_error", err }, "unhandled error");
  return problem(c, {
    type: `${BASE_TYPE_URI}/internal`,
    title: "Internal server error",
    status: 500,
    instance,
    requestId,
  });
};

export const notFound: NotFoundHandler = (c) =>
  problem(c, {
    type: `${BASE_TYPE_URI}/not-found`,
    title: "Not found",
    status: 404,
    detail: `No route matches ${c.req.method} ${new URL(c.req.url).pathname}`,
    instance: new URL(c.req.url).pathname,
    requestId: requestIdOf(c),
  });

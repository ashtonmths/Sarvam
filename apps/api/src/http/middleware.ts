import type { Context, ErrorHandler, NotFoundHandler } from "hono";
import { ZodError } from "zod";
import { AppError, RateLimitedError } from "../errors.js";

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
  c.header("Content-Type", "application/problem+json");
  return c.json(body, body.status as 400);
}

/** Mints or honors `X-Request-Id` and echoes it on every response. */
export async function requestId(c: Context, next: () => Promise<void>) {
  const inbound = c.req.header("X-Request-Id");
  const id = inbound && inbound.length <= 200 ? inbound : crypto.randomUUID();
  c.set("requestId", id);
  c.header("X-Request-Id", id);
  await next();
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
      console.error(`[${requestId}] ${err.name}: ${err.message}`, err.meta);
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

  console.error(`[${requestId}] unhandled`, err);
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

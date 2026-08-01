/**
 * The error taxonomy. The three-way split is load-bearing downstream: alerting
 * pages on SystemError rate but only dashboards UserErrors, connectors wrap
 * every provider fault in UpstreamError so a flaky Airtable is never paged as
 * a Sadhak bug, and the web app renders UserError detail verbatim while
 * showing a generic message for the rest.
 */

export abstract class AppError extends Error {
  abstract readonly status: number;
  abstract readonly type: string;
  /** false ⇒ detail is redacted from the response and only logged. */
  readonly expose: boolean = true;

  constructor(
    message: string,
    readonly meta: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = new.target.name;
  }
}

/** 4xx — the caller's request is wrong. */
export class UserError extends AppError {
  readonly status: number;
  readonly type: string;

  constructor(
    message: string,
    options: { status?: number; type?: string; meta?: Record<string, unknown> } = {},
  ) {
    super(message, options.meta ?? {});
    this.status = options.status ?? 400;
    this.type = options.type ?? "validation";
  }
}

export class UnauthorizedError extends UserError {
  constructor(message = "Authentication required") {
    super(message, { status: 401, type: "unauthorized" });
  }
}

export class ForbiddenError extends UserError {
  constructor(message = "You do not have permission to do that") {
    super(message, { status: 403, type: "forbidden" });
  }
}

/**
 * 404 doubles as the enumeration-safe answer for "exists but not yours" — a
 * wrong org id must be indistinguishable from one that does not exist.
 */
export class NotFoundError extends UserError {
  constructor(message = "Not found") {
    super(message, { status: 404, type: "not-found" });
  }
}

export class ConflictError extends UserError {
  constructor(message: string) {
    super(message, { status: 409, type: "conflict" });
  }
}

export class RateLimitedError extends UserError {
  constructor(
    message = "Too many requests",
    readonly retryAfterSeconds = 60,
  ) {
    super(message, { status: 429, type: "rate-limited" });
  }
}

/** 5xx — our bug or our infrastructure. Detail never reaches the client. */
export class SystemError extends AppError {
  readonly status = 500;
  readonly type = "internal";
  override readonly expose = false;
}

/** 502/504 — a connector, OpenRouter, or n8n failed us. */
export class UpstreamError extends AppError {
  readonly status: number;
  readonly type = "upstream";

  constructor(
    message: string,
    options: { status?: 502 | 504; meta?: Record<string, unknown> } = {},
  ) {
    super(message, options.meta ?? {});
    this.status = options.status ?? 502;
  }
}

export class NotImplementedError extends AppError {
  readonly status = 501;
  readonly type = "not-implemented";
}

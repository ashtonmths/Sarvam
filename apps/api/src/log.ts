import { AsyncLocalStorage } from "node:async_hooks";
import { type Logger, pino } from "pino";
import { config, isProd } from "./config.js";
import { currentTraceId } from "./tracing.js";

/**
 * One logger, JSON on stdout, correlated by request id.
 *
 * The correlation is ambient rather than threaded. A crawl fails four call
 * frames below a route handler, and passing a logger down every one of those
 * signatures is how logging stops being added at all. `AsyncLocalStorage`
 * carries the request id across awaits so any module can log without knowing
 * it is inside a request — and the job worker sets the same store, so a
 * background failure is just as traceable as an HTTP one.
 *
 * Redaction is a real control here, not hygiene: this process handles
 * connector credentials, session tokens and API keys, and a log line is the
 * easiest way to leak all three at once into a system with different access
 * rules than the database.
 */

export interface LogContext {
  requestId?: string;
  /** Present only when a collector is configured. Joins logs to spans. */
  orgId?: number;
  jobId?: number;
  actor?: string;
}

const store = new AsyncLocalStorage<LogContext>();

/**
 * Paths pino replaces with `[Redacted]` before serializing. Header names are
 * lowercase because that is how they arrive.
 *
 * A wildcard alone would not be enough — `*.password` misses a bare
 * `password` at the root — so both shapes are listed for anything that has
 * been seen at either depth.
 */
const REDACTED = [
  "password",
  "*.password",
  "token",
  "*.token",
  "secret",
  "*.secret",
  "apiKey",
  "*.apiKey",
  "credential",
  "*.credential",
  "authorization",
  "*.authorization",
  "cookie",
  "*.cookie",
  "req.headers.authorization",
  "req.headers.cookie",
  "req.headers['x-api-key']",
  "DATABASE_URL",
  "*.DATABASE_URL",
  "CREDENTIAL_MASTER_KEY",
  "*.CREDENTIAL_MASTER_KEY",
  "SESSION_SECRET",
  "*.SESSION_SECRET",
  "OPENROUTER_API_KEY",
  "*.OPENROUTER_API_KEY",
];

export const baseLogger = pino({
  level: config.LOG_LEVEL,
  redact: { paths: REDACTED, censor: "[Redacted]" },
  // `time` over pino's default epoch `t`: these lines are read by humans in a
  // terminal at least as often as by a log shipper.
  timestamp: pino.stdTimeFunctions.isoTime,
  base: isProd
    ? { service: "sadhak-api", ...(config.GIT_SHA ? { version: config.GIT_SHA } : {}) }
    : {},
  formatters: {
    level: (label) => ({ level: label }),
  },
});

/**
 * The logger to use everywhere. Reads whatever request or job context is
 * ambient, so call sites never pass one around.
 */
export function log(): Logger {
  const context = store.getStore();
  // Resolved here rather than stored: the active span changes over the life of
  // a request, and a trace id captured when the context opened would name
  // whatever was active then — usually nothing, since the request context is
  // opened before the server span exists. Read at write time it is always the
  // span the line is actually about.
  const traceId = currentTraceId();
  if (!context && !traceId) return baseLogger;
  return baseLogger.child({ ...context, ...(traceId ? { traceId } : {}) });
}

/** Runs `fn` with `context` attached to every log line it produces. */
export function withLogContext<T>(context: LogContext, fn: () => T): T {
  const parent = store.getStore();
  return store.run({ ...parent, ...context }, fn);
}

/** Adds fields to the context already in scope, if there is one. */
export function addLogContext(context: LogContext): void {
  const current = store.getStore();
  if (current) Object.assign(current, context);
}

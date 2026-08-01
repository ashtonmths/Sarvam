/**
 * A typed map, nothing more. Everything agentic registers a handler here
 * instead of inventing its own loop.
 */

export interface JobContext {
  jobId: number;
  /** Null for system jobs (retention). Handlers scope by this, never by payload. */
  orgId: number | null;
  attempt: number;
  /** Touch to prove the worker is alive on a long job. */
  heartbeat: () => Promise<void>;
  signal: AbortSignal;
}

export type JobHandler = (
  payload: Record<string, unknown>,
  ctx: JobContext,
) => Promise<void>;

export interface HandlerOptions {
  timeoutMs?: number;
  maxAttempts?: number;
}

interface Registration {
  fn: JobHandler;
  options: HandlerOptions;
}

const handlers = new Map<string, Registration>();

export function registerHandler(
  kind: string,
  fn: JobHandler,
  options: HandlerOptions = {},
): void {
  handlers.set(kind, { fn, options });
}

export function getHandler(kind: string): Registration | undefined {
  return handlers.get(kind);
}

export function registeredKinds(): string[] {
  return [...handlers.keys()].sort();
}

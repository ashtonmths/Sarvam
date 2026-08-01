import { UpstreamError, UserError } from "../errors.js";
import { pinnedFetch } from "../net/pinned-fetch.js";
import type { Secret } from "../vault/secret.js";
import type { ConnectorSlug } from "./types.js";

/**
 * The only way connector code performs I/O, and the only place `reveal()` is
 * called on a crawl path. Getting throttled is survivable; ignoring throttles
 * until a provider blocks the app for every tenant is not.
 */

/** Requests per second, per provider's documented limit. */
const RATE_LIMITS: Record<ConnectorSlug, number> = {
  airtable: 4, // documented 5 rps per base — stay under
  slack: 1,
  github: 1,
  n8n: 5,
  postgres: 100, // pooled short-lived connections, not HTTP
};

const MAX_RETRIES = 3;

/**
 * How many times one request will wait out a rate limit before giving up.
 * Bounded so a provider that is limiting indefinitely cannot pin a worker.
 */
const MAX_THROTTLE_WAITS = 5;

/**
 * `Retry-After` as milliseconds. The header is either delta-seconds or an
 * HTTP-date, and GitHub genuinely sends the date form — parsing only the
 * integer yielded NaN there and silently fell through to plain backoff,
 * ignoring the one number the provider actually told us.
 */
function retryAfterMs(response: Response): number | null {
  const raw = response.headers.get("retry-after");
  if (!raw) return null;

  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;

  const at = Date.parse(raw);
  if (Number.isNaN(at)) return null;
  return Math.max(0, at - Date.now());
}

class TokenBucket {
  #tokens: number;
  #lastRefill = Date.now();

  constructor(private readonly ratePerSecond: number) {
    this.#tokens = ratePerSecond;
  }

  async take(): Promise<void> {
    for (;;) {
      const now = Date.now();
      this.#tokens = Math.min(
        this.ratePerSecond,
        this.#tokens + ((now - this.#lastRefill) / 1000) * this.ratePerSecond,
      );
      this.#lastRefill = now;

      if (this.#tokens >= 1) {
        this.#tokens -= 1;
        return;
      }
      const waitMs = Math.ceil(((1 - this.#tokens) / this.ratePerSecond) * 1000);
      await sleep(waitMs);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface InstanceHttpOptions {
  slug: ConnectorSlug;
  instanceId: number;
  baseUrl: string;
  secret: Secret;
  /** Header builder: the one call site that reveals the secret. */
  authHeaders: (secret: Secret) => Record<string, string>;
  /**
   * Path allowlist. A request outside these patterns throws — which is what
   * makes "we never fetch records" a construction rather than a code review.
   */
  allowedPaths: RegExp[];
  /**
   * Self-hosted n8n is the one connector whose base URL a customer supplies
   * and the one that legitimately speaks http on a private network. Every
   * other connector talks to a fixed vendor domain over https, so this stays
   * off and the guard refuses anything that is not public https.
   */
  allowPrivateHttp?: boolean;
}

export class InstanceHttp {
  readonly #bucket: TokenBucket;

  constructor(private readonly options: InstanceHttpOptions) {
    this.#bucket = new TokenBucket(RATE_LIMITS[options.slug] ?? 2);
  }

  assertAllowed(path: string): void {
    if (!this.options.allowedPaths.some((pattern) => pattern.test(path))) {
      throw new UpstreamError(
        `Path "${path}" is not on the ${this.options.slug} allowlist`,
      );
    }
  }

  async getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
    this.assertAllowed(path);
    const url = new URL(path, this.options.baseUrl).toString();

    /**
     * Rate-limit waits do not count against the retry budget.
     *
     * A 429 is the provider saying "not yet", not "this failed" — but it
     * consumed an attempt like any error, so three consecutive 429s threw
     * "exhausted retries" on a request that had never actually been tried.
     * That is the opposite of what `Retry-After` means. They get their own
     * bounded allowance instead, so a busy provider costs waiting rather than
     * a failed crawl.
     */
    let throttled = 0;

    for (let attempt = 1; attempt <= MAX_RETRIES; ) {
      await this.#bucket.take();

      let response: Response;
      try {
        response = await pinnedFetch(
          url,
          {
            headers: {
              accept: "application/json",
              ...this.options.authHeaders(this.options.secret),
            },
            ...(signal ? { signal } : {}),
          },
          {
            allowHttp: this.options.allowPrivateHttp ?? false,
            ...(this.options.allowPrivateHttp ? {} : { allowPrivateHosts: [] }),
          },
        );
      } catch (error) {
        // A refused destination is the caller's configuration being wrong, not
        // the provider being down. Retrying it would just re-resolve the same
        // private address twice more.
        if (error instanceof UserError) throw error;
        if (attempt === MAX_RETRIES) {
          throw new UpstreamError(
            `${this.options.slug} request failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        attempt += 1;
        await sleep(backoffWithJitter(attempt));
        continue;
      }

      if (response.ok) return (await response.json()) as T;

      // Auth failures are terminal — retrying a revoked token just burns quota.
      if (response.status === 401 || response.status === 403) {
        throw new UpstreamError(
          `${this.options.slug} rejected the credential (${response.status})`,
          { status: 502 },
        );
      }

      if (response.status === 429) {
        throttled += 1;
        if (throttled > MAX_THROTTLE_WAITS) {
          throw new UpstreamError(
            `${this.options.slug} is rate limiting persistently; giving this crawl back rather than holding a worker`,
            { status: 502 },
          );
        }
        await sleep(retryAfterMs(response) ?? backoffWithJitter(throttled));
        continue;
      }

      if (response.status >= 500 && attempt < MAX_RETRIES) {
        attempt += 1;
        await sleep(backoffWithJitter(attempt));
        continue;
      }

      throw new UpstreamError(
        `${this.options.slug} returned ${response.status} for ${path}`,
        { status: 502 },
      );
    }

    throw new UpstreamError(`${this.options.slug} exhausted retries for ${path}`);
  }
}

export function backoffWithJitter(attempt: number, random = Math.random): number {
  const base = Math.min(1000 * 2 ** (attempt - 1), 15_000);
  return Math.floor(base * (0.5 + random() * 0.5));
}

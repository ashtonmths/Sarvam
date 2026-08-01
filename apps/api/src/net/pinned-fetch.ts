import { Agent, fetch as undiciFetch } from "undici";
import { assertPublicUrl, type EgressOptions, type PinnedAddress } from "./guard.js";

/**
 * Fetch that connects only to addresses the guard already approved.
 *
 * Validating a hostname and then handing that hostname to `fetch` is a
 * time-of-check/time-of-use bug wearing a security control's clothing: the
 * second resolution is a fresh DNS answer, and an attacker who controls the
 * zone returns a public address to the check and 10.0.0.5 to the fetch. The
 * only fix is to connect to the exact addresses that were checked, which means
 * overriding the lookup rather than trusting the resolver twice.
 *
 * `maxRedirections: 0` for the same reason: provider APIs do not redirect, and
 * a redirect is a second URL that nothing validated. One that appears is
 * treated as hostile.
 */

/** A resolver that answers only with what the guard already cleared. */
function pinnedLookup(addresses: PinnedAddress[]) {
  return (
    _hostname: string,
    _options: unknown,
    callback: (
      err: Error | null,
      addresses: Array<{ address: string; family: number }>,
    ) => void,
  ): void => {
    callback(
      null,
      addresses.map((entry) => ({ address: entry.address, family: entry.family })),
    );
  };
}

export interface PinnedFetchInit {
  headers?: Record<string, string>;
  method?: string;
  body?: string;
  signal?: AbortSignal;
}

/**
 * Validates the URL, then fetches it against the validated addresses. The
 * agent is per-call because the pinned addresses are per-URL; these are crawl
 * requests measured in seconds, not a hot path where connection reuse pays.
 */
export async function pinnedFetch(
  url: string | URL,
  init: PinnedFetchInit = {},
  egress: EgressOptions = {},
): Promise<Response> {
  const target = typeof url === "string" ? new URL(url) : url;
  const addresses = await assertPublicUrl(target, egress);

  // Redirects are refused by `redirect: "error"` on the request below rather
  // than by the agent: a redirect is a second URL that the guard never saw.
  const agent = new Agent({ connect: { lookup: pinnedLookup(addresses) } });

  try {
    const response = await undiciFetch(target, {
      ...(init.method ? { method: init.method } : {}),
      ...(init.headers ? { headers: init.headers } : {}),
      ...(init.body ? { body: init.body } : {}),
      ...(init.signal ? { signal: init.signal } : {}),
      dispatcher: agent,
      redirect: "error",
    });
    return response as unknown as Response;
  } finally {
    void agent.close().catch(() => undefined);
  }
}

import type { Context } from "hono";

/**
 * The one place a client IP is derived. Sessions, the audit log and the rate
 * limiter all read it from here so they cannot disagree about who a caller is.
 *
 * `X-Forwarded-For` is a client-controlled list that each proxy appends to, so
 * the *first* entry is whatever the caller typed and the *last* is the only
 * hop our own infrastructure wrote. We take the last.
 *
 * That is correct only while exactly one trusted proxy sits in front of the
 * API. The invariant it rests on: the api container is `expose`-only on
 * `dokploy-network` and is never port-published, so the sole route to it is
 * through Traefik. If that ever changes, a caller can reach the API directly
 * and write any `X-Forwarded-For` it likes, and every IP-keyed limit below
 * becomes spoofable. `docker-compose.dokploy.yml` carries the same warning at
 * the port declaration.
 */
export function clientIp(c: Context): string {
  const forwarded = c.req.header("x-forwarded-for");
  if (forwarded) {
    const hops = forwarded
      .split(",")
      .map((hop) => hop.trim())
      .filter((hop) => hop.length > 0);
    const nearest = hops.at(-1);
    if (nearest) return normalize(nearest);
  }

  // Direct connection (local dev, or a healthcheck on the container network).
  const real = c.req.header("x-real-ip");
  if (real) return normalize(real);

  return "unknown";
}

/**
 * IPv4-mapped IPv6 (`::ffff:1.2.3.4`) and a bare IPv4 are the same client, and
 * a limiter that treats them as two buckets gives that client double the
 * budget. Brackets come off IPv6 literals for the same reason.
 */
function normalize(ip: string): string {
  let value = ip;
  if (value.startsWith("[")) {
    const close = value.indexOf("]");
    if (close > 0) value = value.slice(1, close);
  }
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(value);
  return (mapped?.[1] ?? value).toLowerCase();
}

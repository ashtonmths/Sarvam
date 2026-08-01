import { lookup } from "node:dns/promises";
import { config } from "../config.js";
import { UserError } from "../errors.js";

/**
 * The egress guard. Sadhak fetches URLs its customers configure — a
 * self-hosted n8n base URL, a Postgres host — and an unguarded fetch of a
 * customer-supplied URL is a free port scan of our Docker network and of the
 * VPS metadata endpoint.
 *
 * Two properties matter and only one of them is obvious:
 *
 *  1. Every resolved address is checked, not just the first. A hostname with
 *     both a public and a private A record is otherwise a bypass.
 *  2. The checked addresses are *returned*, so the caller connects to exactly
 *     those and not to whatever DNS says a second later. Validating a hostname
 *     and then handing that hostname to `fetch` re-resolves it, and a record
 *     that flips to 10.0.0.5 in between is the DNS-rebinding bypass this
 *     function would otherwise pretend to stop.
 */

export interface PinnedAddress {
  address: string;
  family: 4 | 6;
}

interface Range {
  /** First address of the block, as a bigint in the family's space. */
  base: bigint;
  /** Number of leading bits that are fixed. */
  prefix: number;
  family: 4 | 6;
  why: string;
}

function v4(dotted: string, prefix: number, why: string): Range {
  return { base: v4ToBigInt(dotted), prefix, family: 4, why };
}

function v6(address: string, prefix: number, why: string): Range {
  return { base: v6ToBigInt(address), prefix, family: 6, why };
}

/**
 * Everything that is not a public destination. 169.254.0.0/16 is the one that
 * turns a mistake into a breach: it is where every cloud provider parks its
 * instance-credentials endpoint.
 */
const BLOCKED: Range[] = [
  v4("0.0.0.0", 8, "this network"),
  v4("10.0.0.0", 8, "private"),
  v4("100.64.0.0", 10, "carrier-grade NAT"),
  v4("127.0.0.0", 8, "loopback"),
  v4("169.254.0.0", 16, "link-local, including cloud metadata"),
  v4("172.16.0.0", 12, "private"),
  v4("192.0.0.0", 24, "IETF protocol assignments"),
  v4("192.168.0.0", 16, "private"),
  v4("198.18.0.0", 15, "benchmarking"),
  v4("224.0.0.0", 4, "multicast"),
  v4("240.0.0.0", 4, "reserved"),
  v6("::", 128, "unspecified"),
  v6("::1", 128, "loopback"),
  v6("fc00::", 7, "unique local"),
  v6("fe80::", 10, "link-local"),
  v6("ff00::", 8, "multicast"),
];

function v4ToBigInt(dotted: string): bigint {
  const parts = dotted.split(".");
  if (parts.length !== 4) throw new Error(`not an IPv4 address: ${dotted}`);
  let value = 0n;
  for (const part of parts) {
    const octet = Number(part);
    if (!Number.isInteger(octet) || octet < 0 || octet > 255) {
      throw new Error(`not an IPv4 address: ${dotted}`);
    }
    value = (value << 8n) | BigInt(octet);
  }
  return value;
}

function v6ToBigInt(address: string): bigint {
  const [head, tail] = address.split("::");
  const headGroups = head ? head.split(":").filter((g) => g.length > 0) : [];
  const tailGroups = tail ? tail.split(":").filter((g) => g.length > 0) : [];

  // A trailing IPv4 form (::ffff:1.2.3.4) contributes two groups, not one.
  const expand = (groups: string[]): string[] =>
    groups.flatMap((group) => {
      if (!group.includes(".")) return [group];
      const packed = v4ToBigInt(group);
      return [
        (packed >> 16n).toString(16).padStart(4, "0"),
        (packed & 0xffffn).toString(16).padStart(4, "0"),
      ];
    });

  const left = expand(headGroups);
  const right = expand(tailGroups);
  const fill = 8 - left.length - right.length;
  if (fill < 0) throw new Error(`not an IPv6 address: ${address}`);

  const all = [
    ...left,
    ...Array.from({ length: address.includes("::") ? fill : 0 }, () => "0"),
    ...right,
  ];
  if (all.length !== 8) throw new Error(`not an IPv6 address: ${address}`);

  let value = 0n;
  for (const group of all) {
    const part = Number.parseInt(group, 16);
    if (!Number.isInteger(part) || part < 0 || part > 0xffff) {
      throw new Error(`not an IPv6 address: ${address}`);
    }
    value = (value << 16n) | BigInt(part);
  }
  return value;
}

function inRange(value: bigint, range: Range): boolean {
  const width = range.family === 4 ? 32 : 128;
  const shift = BigInt(width - range.prefix);
  return value >> shift === range.base >> shift;
}

/**
 * Why an address is refused, or null if it is a legitimate public
 * destination. Exported because the range table is the part worth testing
 * directly, one address at a time.
 */
export function blockReason(address: string): string | null {
  let value: bigint;
  let family: 4 | 6;

  try {
    if (address.includes(":")) {
      family = 6;
      value = v6ToBigInt(address);
      // An IPv4-mapped address (::ffff:10.0.0.1) is an IPv4 destination
      // wearing a v6 costume, and has to be judged by the v4 table.
      const MAPPED_PREFIX = 0xffffn;
      if (value >> 32n === MAPPED_PREFIX) {
        return blockReason(v4FromBigInt(value & 0xffffffffn));
      }
    } else {
      family = 4;
      value = v4ToBigInt(address);
    }
  } catch {
    // Unparseable is not provably public, so it does not get to pass.
    return "unparseable address";
  }

  for (const range of BLOCKED) {
    if (range.family === family && inRange(value, range)) return range.why;
  }
  return null;
}

function v4FromBigInt(value: bigint): string {
  return [24n, 16n, 8n, 0n].map((shift) => (value >> shift) & 0xffn).join(".");
}

export interface EgressOptions {
  /**
   * Hostnames the operator has vouched for, bypassing the range check. The
   * bundled n8n is reachable only on the compose network, so crawling the
   * stack's own instance requires this. Operator-set only: it comes from the
   * platform environment and is never reachable from org-level config, or a
   * tenant could allowlist their way to the metadata endpoint.
   */
  allowPrivateHosts?: string[];
  /**
   * http: is refused by default. Self-hosted n8n on a private network is the
   * documented exception, acknowledged at the call site rather than globally.
   */
  allowHttp?: boolean;
}

/**
 * Validates a user-configured URL for egress and returns the addresses the
 * caller must connect to. Throws `UserError` with type `egress-denied` for
 * anything that is not a public destination.
 */
export async function assertPublicUrl(
  url: URL,
  options: EgressOptions = {},
): Promise<PinnedAddress[]> {
  const allowHttp = options.allowHttp ?? false;
  if (url.protocol !== "https:" && !(allowHttp && url.protocol === "http:")) {
    throw new UserError(`Refusing to fetch ${url.protocol}//: https is required`, {
      status: 422,
      type: "egress-denied",
    });
  }

  return assertPublicHost(url.hostname, options);
}

/**
 * The range check on its own, for protocols that are not HTTP.
 *
 * A Postgres connection string names a customer-supplied host, which is the
 * other half of the reason this module exists — and `postgres.js` resolves the
 * hostname itself, so the addresses returned here cannot be pinned the way
 * `pinnedFetch` pins them. That leaves a DNS-rebinding window this function
 * cannot close: it stops a literal `10.0.0.5` or `169.254.169.254`, and it
 * does not stop a hostname that answers publicly here and privately a
 * millisecond later. Closing that needs the driver to accept a pinned address,
 * which it does not.
 */
export async function assertPublicHost(
  rawHostname: string,
  options: EgressOptions = {},
): Promise<PinnedAddress[]> {
  const hostname = rawHostname.replace(/^\[|\]$/g, "").toLowerCase();
  const allowed = options.allowPrivateHosts ?? config.EGRESS_ALLOW_PRIVATE_HOSTS;
  if (allowed.includes(hostname)) {
    // Still resolved, so the caller can pin — just not range-checked.
    return resolveAll(hostname);
  }

  const addresses = await resolveAll(hostname);
  for (const { address } of addresses) {
    const reason = blockReason(address);
    if (reason !== null) {
      throw new UserError(
        `Refusing to fetch ${hostname}: it resolves to ${address} (${reason})`,
        { status: 422, type: "egress-denied" },
      );
    }
  }
  return addresses;
}

async function resolveAll(hostname: string): Promise<PinnedAddress[]> {
  try {
    const records = await lookup(hostname, { all: true });
    if (records.length === 0) {
      throw new UserError(`Refusing to fetch ${hostname}: it resolves to nothing`, {
        status: 422,
        type: "egress-denied",
      });
    }
    return records.map((record) => ({
      address: record.address,
      family: record.family === 6 ? 6 : 4,
    }));
  } catch (error) {
    if (error instanceof UserError) throw error;
    throw new UserError(`Refusing to fetch ${hostname}: it does not resolve`, {
      status: 422,
      type: "egress-denied",
    });
  }
}

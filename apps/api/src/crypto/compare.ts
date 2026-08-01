import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Constant-time comparison for secrets that arrive as strings — webhook
 * signatures, bearer tokens, API keys.
 *
 * This existed as an inline two-liner in five files, which is four more places
 * than a security primitive should live. The subtle part is the length guard:
 * `timingSafeEqual` *throws* on mismatched lengths rather than returning false,
 * so every copy had to remember it, and a copy that forgot would turn a
 * forged-signature check into a 500.
 *
 * Leaking the length is accepted. An attacker who can send requests already
 * knows how long our signatures are — they are a fixed-width hex digest.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * Verifies an HMAC-SHA256 signature over a raw body.
 *
 * `rawBody` must be the bytes as received. Re-serializing parsed JSON changes
 * key order and whitespace, and the signature then never matches — which
 * presents as "the provider's signatures are broken" rather than as our bug.
 */
export function verifyHmacSha256(options: {
  rawBody: string;
  key: Buffer | string;
  presented: string | undefined;
  /** Prefix the provider puts before the digest, e.g. "hmac-sha256=". */
  prefix?: string;
  encoding?: "hex" | "base64";
}): boolean {
  if (!options.presented) return false;

  const digest = createHmac("sha256", options.key)
    .update(options.rawBody)
    .digest(options.encoding ?? "hex");

  return constantTimeEqual(`${options.prefix ?? ""}${digest}`, options.presented);
}

import { createHmac } from "node:crypto";
import { config } from "../config.js";
import { constantTimeEqual } from "../crypto/compare.js";
import type { Category } from "./mailer.js";

/**
 * Unsubscribe tokens: signed, not stored.
 *
 * The RFC 8058 one-click target has to work with **zero interaction** — no
 * login, no session, one POST from a mail client the user never opened. So the
 * token has to carry its own authority. An HMAC over `userId:category` keyed on
 * the session secret does that without a table, and without a lookup that could
 * fail at exactly the moment somebody is trying to make us stop emailing them.
 *
 * Deliberately no expiry. An unsubscribe link in a two-year-old email should
 * still work; the whole point is that the recipient gets to end this whenever
 * they decide to, not within a window we chose.
 */

function sign(payload: string): string {
  return createHmac("sha256", config.SESSION_SECRET).update(payload).digest("base64url");
}

export function unsubscribeToken(userId: number, category: Category): string {
  const payload = `${userId}:${category}`;
  return `${Buffer.from(payload).toString("base64url")}.${sign(payload)}`;
}

/** Returns null for anything that does not verify. Never throws on input. */
export function readUnsubscribeToken(
  token: string,
): { userId: number; category: Category } | null {
  const [encoded, signature] = token.split(".");
  if (!encoded || !signature) return null;

  let payload: string;
  try {
    payload = Buffer.from(encoded, "base64url").toString("utf8");
  } catch {
    return null;
  }

  if (!constantTimeEqual(signature, sign(payload))) return null;

  const [rawId, category] = payload.split(":");
  const userId = Number(rawId);
  if (!Number.isInteger(userId) || userId <= 0) return null;
  // `auth` tokens are never minted, so accepting one would be a way to switch
  // off password resets for somebody else's account.
  if (category !== "lifecycle" && category !== "digest") return null;

  return { userId, category };
}

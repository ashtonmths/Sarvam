import { randomBytes, type ScryptOptions, scrypt, timingSafeEqual } from "node:crypto";

/**
 * scrypt via node:crypto — no dependency, and the parameters are recorded in
 * the hash string so raising them later stays backward compatible.
 */

function scryptAsync(
  password: string,
  salt: Buffer,
  keyLength: number,
  options: ScryptOptions,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keyLength, options, (error, derived) => {
      if (error) reject(error);
      else resolve(derived);
    });
  });
}

const N = 16_384;
const r = 8;
const p = 1;
const KEY_LEN = 64;

export const MIN_PASSWORD_LENGTH = 12;
export const MAX_PASSWORD_LENGTH = 128;

/** The handful of passwords that would otherwise pass a length-only check. */
const DENYLIST = new Set([
  "password1234",
  "passwordpassword",
  "123456789012",
  "qwertyuiop12",
  "letmeinletmein",
  "administrator",
  "sadhaksadhak",
]);

export function passwordProblem(password: string): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) {
    return `Password must be at least ${MIN_PASSWORD_LENGTH} characters`;
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    return `Password must be at most ${MAX_PASSWORD_LENGTH} characters`;
  }
  if (DENYLIST.has(password.toLowerCase())) {
    return "That password is too common — pick something else";
  }
  return null;
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await scryptAsync(password, salt, KEY_LEN, { N, r, p });
  return ["scrypt", N, r, p, salt.toString("base64"), derived.toString("base64")].join(
    "$",
  );
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;

  const [, nRaw, rRaw, pRaw, saltRaw, hashRaw] = parts;
  const salt = Buffer.from(saltRaw ?? "", "base64");
  const expected = Buffer.from(hashRaw ?? "", "base64");
  if (salt.length === 0 || expected.length === 0) return false;

  const derived = await scryptAsync(password, salt, expected.length, {
    N: Number(nRaw),
    r: Number(rRaw),
    p: Number(pRaw),
  });

  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

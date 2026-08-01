import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { config } from "../config.js";
import { SystemError } from "../errors.js";

/**
 * The keyring abstraction exists so that "master key in env on the VPS" today
 * becomes KMS-wrapped data keys, or customer-held BYO-KMS, without touching a
 * single call site.
 *
 * sealed = IV(12) ‖ GCM tag(16) ‖ ciphertext
 */

export interface Keyring {
  seal(plaintext: Buffer, aad: string): { keyId: string; sealed: Buffer };
  /** Throws on tamper, wrong key, or AAD mismatch. */
  open(keyId: string, sealed: Buffer, aad: string): Buffer;
}

const IV_LEN = 12;
const TAG_LEN = 16;

/** Master key format: `v1:<base64 32 bytes>`. The prefix is the keyId. */
function parseKey(raw: string): { keyId: string; key: Buffer } {
  const separator = raw.indexOf(":");
  if (separator < 1) {
    throw new SystemError("CREDENTIAL_MASTER_KEY must look like v1:<base64 32 bytes>");
  }
  const keyId = raw.slice(0, separator);
  const key = Buffer.from(raw.slice(separator + 1), "base64");
  if (key.length !== 32) {
    throw new SystemError("CREDENTIAL_MASTER_KEY must decode to exactly 32 bytes");
  }
  return { keyId, key };
}

export class EnvKeyring implements Keyring {
  readonly #keys = new Map<string, Buffer>();
  readonly #currentKeyId: string;

  constructor(current: string, previous?: string) {
    const parsedCurrent = parseKey(current);
    this.#keys.set(parsedCurrent.keyId, parsedCurrent.key);
    this.#currentKeyId = parsedCurrent.keyId;

    if (previous) {
      const parsedPrevious = parseKey(previous);
      // Seal always with current, open by keyId — that dual-key window is what
      // makes rotation a config change rather than an outage.
      if (!this.#keys.has(parsedPrevious.keyId)) {
        this.#keys.set(parsedPrevious.keyId, parsedPrevious.key);
      }
    }
  }

  get currentKeyId(): string {
    return this.#currentKeyId;
  }

  seal(plaintext: Buffer, aad: string): { keyId: string; sealed: Buffer } {
    const key = this.#keys.get(this.#currentKeyId);
    if (!key) throw new SystemError("Sealing key unavailable");

    const iv = randomBytes(IV_LEN);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(Buffer.from(aad, "utf8"));
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();

    return { keyId: this.#currentKeyId, sealed: Buffer.concat([iv, tag, ciphertext]) };
  }

  open(keyId: string, sealed: Buffer, aad: string): Buffer {
    const key = this.#keys.get(keyId);
    if (!key) throw new SystemError(`No key available for keyId "${keyId}"`);
    if (sealed.length < IV_LEN + TAG_LEN)
      throw new SystemError("Sealed blob is truncated");

    const iv = sealed.subarray(0, IV_LEN);
    const tag = sealed.subarray(IV_LEN, IV_LEN + TAG_LEN);
    const ciphertext = sealed.subarray(IV_LEN + TAG_LEN);

    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAAD(Buffer.from(aad, "utf8"));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  }
}

let cached: EnvKeyring | null = null;

/** Null when no master key is configured: credential storage is feature-gated. */
export function getKeyring(): EnvKeyring | null {
  if (cached) return cached;
  if (!config.CREDENTIAL_MASTER_KEY) return null;
  cached = new EnvKeyring(
    config.CREDENTIAL_MASTER_KEY,
    config.CREDENTIAL_MASTER_KEY_PREVIOUS,
  );
  return cached;
}

/**
 * A ciphertext copied onto another org's row fails to open. Cheap, and it
 * closes a real cross-tenant splice attack.
 */
export function credentialAad(
  orgId: number,
  instanceId: number,
  scope: string,
  kind: string,
): string {
  return `${orgId}:${instanceId}:${scope}:${kind}`;
}

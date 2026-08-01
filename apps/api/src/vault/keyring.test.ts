import { randomBytes } from "node:crypto";
import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import { credentialAad, EnvKeyring } from "./keyring.js";
import { Secret } from "./secret.js";

const KEY_A = `v1:${randomBytes(32).toString("base64")}`;
const KEY_B = `v2:${randomBytes(32).toString("base64")}`;

describe("EnvKeyring", () => {
  it("round-trips a secret under matching AAD", () => {
    const keyring = new EnvKeyring(KEY_A);
    const aad = credentialAad(1, 2, "read", "api_key");
    const { keyId, sealed } = keyring.seal(Buffer.from("n8n_api_key_value"), aad);

    expect(keyId).toBe("v1");
    expect(keyring.open(keyId, sealed, aad).toString()).toBe("n8n_api_key_value");
  });

  it("produces a different ciphertext each time (random IV per seal)", () => {
    const keyring = new EnvKeyring(KEY_A);
    const aad = credentialAad(1, 2, "read", "api_key");
    const first = keyring.seal(Buffer.from("same"), aad).sealed.toString("base64");
    const second = keyring.seal(Buffer.from("same"), aad).sealed.toString("base64");
    expect(first).not.toBe(second);
  });

  it("throws on a single-byte tamper", () => {
    const keyring = new EnvKeyring(KEY_A);
    const aad = credentialAad(1, 2, "read", "api_key");
    const { keyId, sealed } = keyring.seal(Buffer.from("secret"), aad);

    const tampered = Buffer.from(sealed);
    const last = tampered.length - 1;
    tampered[last] = (tampered[last] ?? 0) ^ 0x01;
    expect(() => keyring.open(keyId, tampered, aad)).toThrow();
  });

  it("refuses a ciphertext spliced onto another org's row", () => {
    const keyring = new EnvKeyring(KEY_A);
    const ownAad = credentialAad(1, 2, "read", "api_key");
    const { keyId, sealed } = keyring.seal(Buffer.from("org one's key"), ownAad);

    const attackerAad = credentialAad(999, 2, "read", "api_key");
    expect(() => keyring.open(keyId, sealed, attackerAad)).toThrow();
  });

  it("refuses to reuse a read credential's blob under the write scope", () => {
    const keyring = new EnvKeyring(KEY_A);
    const readAad = credentialAad(1, 2, "read", "api_key");
    const { keyId, sealed } = keyring.seal(Buffer.from("read-only token"), readAad);

    const writeAad = credentialAad(1, 2, "write", "api_key");
    expect(() => keyring.open(keyId, sealed, writeAad)).toThrow();
  });

  it("opens with a previous key while sealing with the current one", () => {
    const aad = credentialAad(1, 2, "read", "api_key");
    const old = new EnvKeyring(KEY_A);
    const oldBlob = old.seal(Buffer.from("legacy"), aad);

    const rotated = new EnvKeyring(KEY_B, KEY_A);
    expect(rotated.currentKeyId).toBe("v2");
    expect(rotated.open(oldBlob.keyId, oldBlob.sealed, aad).toString()).toBe("legacy");
    expect(rotated.seal(Buffer.from("fresh"), aad).keyId).toBe("v2");
  });

  it("rejects a malformed master key rather than booting insecurely", () => {
    expect(() => new EnvKeyring("no-prefix")).toThrow();
    expect(
      () => new EnvKeyring(`v1:${Buffer.from("short").toString("base64")}`),
    ).toThrow();
  });
});

describe("Secret redaction", () => {
  const secret = new Secret("sk_live_do_not_log_me");

  it("redacts under JSON.stringify", () => {
    expect(JSON.stringify({ token: secret })).toBe('{"token":"[REDACTED]"}');
  });

  it("redacts under template interpolation", () => {
    expect(`${secret}`).toBe("[REDACTED]");
  });

  it("redacts under util.inspect, which is what console.log uses", () => {
    expect(inspect({ token: secret })).toContain("[REDACTED]");
    expect(inspect({ token: secret })).not.toContain("do_not_log_me");
  });

  it("yields the plaintext only through reveal()", () => {
    expect(secret.reveal()).toBe("sk_live_do_not_log_me");
  });

  it("fingerprints to the last four characters", () => {
    expect(secret.fingerprint()).toBe("g_me");
  });
});

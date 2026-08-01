import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

/**
 * The webhook route is a remote instruction to run our machinery, so
 * verification happens over the exact raw bytes and *before* any parsing.
 * These tests pin that, plus the JWT shape GitHub requires.
 */

const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

const SECRET = "test-webhook-secret";

vi.mock("../config.js", () => ({
  config: {
    GITHUB_APP_ID: "123456",
    GITHUB_APP_PRIVATE_KEY: privateKey,
    GITHUB_APP_WEBHOOK_SECRET: SECRET,
  },
  requireEnv: (key: string) =>
    key === "GITHUB_APP_ID"
      ? "123456"
      : key === "GITHUB_APP_PRIVATE_KEY"
        ? privateKey
        : SECRET,
  isProd: false,
}));

const { appJwt, githubAppConfigured, verifyWebhookSignature } = await import("./app.js");
const { createHmac } = await import("node:crypto");

function sign(body: string): string {
  return `sha256=${createHmac("sha256", SECRET).update(body).digest("hex")}`;
}

describe("webhook signature verification", () => {
  const body = JSON.stringify({ action: "opened", number: 41 });

  it("accepts a correctly signed payload", () => {
    expect(verifyWebhookSignature(body, sign(body))).toBe(true);
  });

  it("rejects a tampered body", () => {
    const signature = sign(body);
    const tampered = JSON.stringify({ action: "opened", number: 42 });
    expect(verifyWebhookSignature(tampered, signature)).toBe(false);
  });

  it("rejects a signature from the wrong secret", () => {
    const forged = `sha256=${createHmac("sha256", "wrong").update(body).digest("hex")}`;
    expect(verifyWebhookSignature(body, forged)).toBe(false);
  });

  it("rejects a missing signature rather than defaulting open", () => {
    expect(verifyWebhookSignature(body, undefined)).toBe(false);
    expect(verifyWebhookSignature(body, "")).toBe(false);
  });

  it("rejects a truncated signature without throwing", () => {
    // Length-mismatched buffers would make timingSafeEqual throw, which would
    // surface as a 500 instead of a clean 401.
    expect(() => verifyWebhookSignature(body, "sha256=abc")).not.toThrow();
    expect(verifyWebhookSignature(body, "sha256=abc")).toBe(false);
  });

  it("is byte-exact — whitespace changes invalidate", () => {
    const signature = sign(body);
    expect(verifyWebhookSignature(` ${body}`, signature)).toBe(false);
  });
});

describe("app JWT", () => {
  it("produces three base64url segments", () => {
    const parts = appJwt().split(".");
    expect(parts).toHaveLength(3);
    expect(parts.every((p) => /^[A-Za-z0-9_-]+$/.test(p))).toBe(true);
  });

  it("declares RS256, which is the only algorithm GitHub accepts", () => {
    const [header] = appJwt().split(".");
    const decoded = JSON.parse(Buffer.from(header ?? "", "base64url").toString());
    expect(decoded).toEqual({ alg: "RS256", typ: "JWT" });
  });

  it("back-dates iat and expires inside GitHub's 10-minute ceiling", () => {
    const [, payload] = appJwt().split(".");
    const claims = JSON.parse(Buffer.from(payload ?? "", "base64url").toString()) as {
      iat: number;
      exp: number;
      iss: string;
    };
    const now = Math.floor(Date.now() / 1000);

    // Back-dated to tolerate clock skew against GitHub.
    expect(claims.iat).toBeLessThan(now);
    expect(claims.exp - claims.iat).toBeLessThanOrEqual(600);
    expect(claims.iss).toBe("123456");
  });
});

describe("configuration gate", () => {
  it("reports configured when all three platform secrets are present", () => {
    expect(githubAppConfigured()).toBe(true);
  });
});

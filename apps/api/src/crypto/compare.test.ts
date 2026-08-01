import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { constantTimeEqual, verifyHmacSha256 } from "./compare.js";

describe("constantTimeEqual", () => {
  it("accepts identical strings", () => {
    expect(constantTimeEqual("abc123", "abc123")).toBe(true);
  });

  it("rejects different strings of the same length", () => {
    expect(constantTimeEqual("abc123", "abc124")).toBe(false);
  });

  it("returns false for mismatched lengths instead of throwing", () => {
    // timingSafeEqual throws on length mismatch. Every inline copy of this
    // had to remember the guard, and one that forgot would turn a forged
    // signature into a 500 rather than a rejection.
    expect(() => constantTimeEqual("short", "considerably-longer")).not.toThrow();
    expect(constantTimeEqual("short", "considerably-longer")).toBe(false);
  });

  it("handles empty strings without throwing", () => {
    expect(constantTimeEqual("", "")).toBe(true);
    expect(constantTimeEqual("", "x")).toBe(false);
  });

  it("compares bytes, not code points", () => {
    // Two strings that normalize to the same glyph are still different bytes,
    // and a signature check must not treat them as equal.
    expect(constantTimeEqual("café", "café")).toBe(false);
  });
});

describe("verifyHmacSha256", () => {
  const key = "shared-secret";
  const body = '{"event":"field.deleted","id":"fld123"}';
  const digest = createHmac("sha256", key).update(body).digest("hex");

  it("accepts a correct signature", () => {
    expect(verifyHmacSha256({ rawBody: body, key, presented: digest })).toBe(true);
  });

  it("accepts a correct signature carrying the provider's prefix", () => {
    expect(
      verifyHmacSha256({
        rawBody: body,
        key,
        presented: `hmac-sha256=${digest}`,
        prefix: "hmac-sha256=",
      }),
    ).toBe(true);
  });

  it("rejects a signature computed over a tampered body", () => {
    const tampered = body.replace("fld123", "fld999");

    expect(verifyHmacSha256({ rawBody: tampered, key, presented: digest })).toBe(false);
  });

  it("rejects a signature computed with the wrong key", () => {
    const forged = createHmac("sha256", "other-secret").update(body).digest("hex");

    expect(verifyHmacSha256({ rawBody: body, key, presented: forged })).toBe(false);
  });

  it("rejects a missing signature rather than passing", () => {
    expect(verifyHmacSha256({ rawBody: body, key, presented: undefined })).toBe(false);
    expect(verifyHmacSha256({ rawBody: body, key, presented: "" })).toBe(false);
  });

  it("rejects a correct digest presented without its expected prefix", () => {
    expect(
      verifyHmacSha256({
        rawBody: body,
        key,
        presented: digest,
        prefix: "hmac-sha256=",
      }),
    ).toBe(false);
  });

  it("supports base64 digests", () => {
    const b64 = createHmac("sha256", key).update(body).digest("base64");

    expect(
      verifyHmacSha256({ rawBody: body, key, presented: b64, encoding: "base64" }),
    ).toBe(true);
  });

  it("is sensitive to whitespace, which is why the raw body must be kept", () => {
    // Re-serializing parsed JSON changes spacing and key order; the signature
    // then never matches, and it presents as "their signatures are broken".
    const reserialized = JSON.stringify(JSON.parse(body), null, 2);

    expect(verifyHmacSha256({ rawBody: reserialized, key, presented: digest })).toBe(
      false,
    );
  });
});

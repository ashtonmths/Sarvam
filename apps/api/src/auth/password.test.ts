import { describe, expect, it } from "vitest";
import { hashPassword, passwordProblem, verifyPassword } from "./password.js";

describe("password policy", () => {
  it("requires 12 characters, per NIST length-over-composition", () => {
    expect(passwordProblem("short")).toMatch(/at least 12/);
    expect(passwordProblem("a-perfectly-fine-passphrase")).toBeNull();
  });

  it("caps length so a megabyte password cannot burn CPU", () => {
    expect(passwordProblem("x".repeat(200))).toMatch(/at most 128/);
  });

  it("rejects common passwords that would otherwise pass on length alone", () => {
    expect(passwordProblem("password1234")).toMatch(/too common/);
  });

  it("imposes no composition rules", () => {
    expect(passwordProblem("correct horse battery staple")).toBeNull();
  });
});

describe("hashing", () => {
  it("verifies a correct password", async () => {
    const hash = await hashPassword("a-perfectly-fine-passphrase");
    await expect(verifyPassword("a-perfectly-fine-passphrase", hash)).resolves.toBe(true);
  });

  it("rejects a wrong password", async () => {
    const hash = await hashPassword("a-perfectly-fine-passphrase");
    await expect(verifyPassword("a-perfectly-wrong-passphrase", hash)).resolves.toBe(
      false,
    );
  });

  it("salts, so the same password hashes differently each time", async () => {
    const first = await hashPassword("same-password-twice");
    const second = await hashPassword("same-password-twice");
    expect(first).not.toBe(second);
  });

  it("stores parameters in the hash so they can be raised later", async () => {
    const hash = await hashPassword("a-perfectly-fine-passphrase");
    expect(hash.split("$").slice(0, 4)).toEqual(["scrypt", "16384", "8", "1"]);
  });

  it("returns false rather than throwing on a corrupt stored hash", async () => {
    await expect(verifyPassword("anything", "not-a-hash")).resolves.toBe(false);
    await expect(verifyPassword("anything", "scrypt$1$2$3$$")).resolves.toBe(false);
  });
});

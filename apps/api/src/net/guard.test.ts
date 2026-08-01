import { describe, expect, it } from "vitest";
import { UserError } from "../errors.js";
import { assertPublicUrl, blockReason } from "./guard.js";

/**
 * The range table is the security control, so every listed block gets an
 * address and every address gets an assertion. A guard that silently stopped
 * covering 169.254/16 would still pass a test that only checked 10/8.
 */

describe("blockReason: IPv4", () => {
  it.each([
    ["0.0.0.0", "this network"],
    ["10.0.0.1", "private"],
    ["10.255.255.254", "private"],
    ["100.64.0.1", "carrier-grade NAT"],
    ["127.0.0.1", "loopback"],
    ["169.254.169.254", "link-local, including cloud metadata"],
    ["172.16.0.1", "private"],
    ["172.31.255.254", "private"],
    ["192.0.0.1", "IETF protocol assignments"],
    ["192.168.1.1", "private"],
    ["198.18.0.1", "benchmarking"],
    ["224.0.0.1", "multicast"],
    ["240.0.0.1", "reserved"],
    ["255.255.255.255", "reserved"],
  ])("blocks %s", (address, why) => {
    expect(blockReason(address)).toBe(why);
  });

  it.each([
    "1.1.1.1",
    "8.8.8.8",
    "93.184.216.34",
    // Just outside the private blocks, and therefore genuinely public.
    "9.255.255.255",
    "11.0.0.0",
    "172.15.255.255",
    "172.32.0.0",
    "100.63.255.255",
    "198.20.0.0",
  ])("allows %s", (address) => {
    expect(blockReason(address)).toBeNull();
  });
});

describe("blockReason: IPv6", () => {
  it.each([
    ["::", "unspecified"],
    ["::1", "loopback"],
    ["fc00::1", "unique local"],
    ["fd12:3456::1", "unique local"],
    ["fe80::1", "link-local"],
    ["ff02::1", "multicast"],
  ])("blocks %s", (address, why) => {
    expect(blockReason(address)).toBe(why);
  });

  it.each(["2606:4700:4700::1111", "2001:4860:4860::8888"])("allows %s", (address) => {
    expect(blockReason(address)).toBeNull();
  });
});

describe("blockReason: IPv4-mapped IPv6", () => {
  // The bypass this exists to close: a private IPv4 destination wearing a v6
  // costume must be judged by the v4 table, not waved through as "some v6
  // address that is not in the v6 blocklist".
  it.each([
    ["::ffff:127.0.0.1", "loopback"],
    ["::ffff:10.0.0.1", "private"],
    ["::ffff:169.254.169.254", "link-local, including cloud metadata"],
    ["::ffff:192.168.1.1", "private"],
  ])("blocks %s", (address, why) => {
    expect(blockReason(address)).toBe(why);
  });

  it("allows a mapped public address", () => {
    expect(blockReason("::ffff:8.8.8.8")).toBeNull();
  });
});

describe("blockReason: malformed input", () => {
  it.each(["", "not-an-ip", "999.1.1.1", "1.2.3", "1.2.3.4.5", "::gggg"])(
    "refuses %s rather than passing it",
    (address) => {
      // Unparseable is not provably public, so it must not be allowed through.
      expect(blockReason(address)).not.toBeNull();
    },
  );
});

describe("assertPublicUrl", () => {
  it("refuses http by default", async () => {
    await expect(assertPublicUrl(new URL("http://example.com/"))).rejects.toThrow(
      UserError,
    );
  });

  it("allows http only when the call site acknowledges it", async () => {
    // localhost stands in for the bundled n8n: it resolves to 127.0.0.1, which
    // the range table blocks, so getting addresses back proves the operator
    // allowlist bypassed the check rather than the address being public.
    const pinned = await assertPublicUrl(new URL("http://localhost:5678/"), {
      allowHttp: true,
      allowPrivateHosts: ["localhost"],
    });

    expect(pinned.length).toBeGreaterThan(0);
    expect(blockReason(pinned[0]?.address ?? "")).not.toBeNull();
  });

  it("still refuses an allowlisted host over http when http is not acknowledged", async () => {
    await expect(
      assertPublicUrl(new URL("http://localhost:5678/"), {
        allowPrivateHosts: ["localhost"],
      }),
    ).rejects.toThrow(/https is required/);
  });

  it("refuses a private literal host", async () => {
    await expect(
      assertPublicUrl(new URL("https://169.254.169.254/latest/meta-data/")),
    ).rejects.toThrow(/link-local/);
  });

  it("refuses loopback by literal", async () => {
    await expect(assertPublicUrl(new URL("https://127.0.0.1/"))).rejects.toThrow(
      /loopback/,
    );
  });

  it("refuses a hostname that does not resolve", async () => {
    await expect(
      assertPublicUrl(new URL("https://this-host-does-not-exist.invalid/")),
    ).rejects.toThrow(/does not resolve/);
  });

  it("returns addresses to pin for a public host", async () => {
    const pinned = await assertPublicUrl(new URL("https://one.one.one.one/"));

    expect(pinned.length).toBeGreaterThan(0);
    for (const entry of pinned) {
      expect(blockReason(entry.address)).toBeNull();
    }
  });

  it("carries the egress-denied type so callers can branch on it", async () => {
    const error = await assertPublicUrl(new URL("https://10.0.0.1/")).catch(
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(UserError);
    expect((error as UserError).type).toBe("egress-denied");
    expect((error as UserError).status).toBe(422);
  });

  it("does not let an org-level host bypass the range check", async () => {
    // allowPrivateHosts is operator config. Passing a different private host
    // must still be refused.
    await expect(
      assertPublicUrl(new URL("https://10.0.0.1/"), { allowPrivateHosts: ["n8n"] }),
    ).rejects.toThrow(/private/);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CREDENTIAL_ROUTES, hitMemory, resetMemoryBuckets } from "./rate-limit.js";

/**
 * The in-process tier, which is the one that can be tested without a database.
 * `hitShared` is exercised against real Postgres in the integration suite —
 * mocking the UPSERT here would only assert that a mock returns what it was
 * told to.
 */

describe("hitMemory", () => {
  beforeEach(() => {
    resetMemoryBuckets();
    vi.useFakeTimers();
    // Land on a window boundary so "seconds until rollover" is exact.
    vi.setSystemTime(new Date("2026-07-26T12:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("allows requests up to the limit and denies the next one", () => {
    for (let i = 0; i < 3; i++) {
      expect(hitMemory("ip:1.2.3.4", 3).allowed).toBe(true);
    }

    expect(hitMemory("ip:1.2.3.4", 3).allowed).toBe(false);
  });

  it("keeps denying once over, rather than letting the counter lap", () => {
    for (let i = 0; i < 5; i++) hitMemory("ip:1.2.3.4", 2);

    expect(hitMemory("ip:1.2.3.4", 2).allowed).toBe(false);
  });

  it("counts each bucket separately", () => {
    expect(hitMemory("ip:1.1.1.1", 1).allowed).toBe(true);
    expect(hitMemory("ip:2.2.2.2", 1).allowed).toBe(true);
    expect(hitMemory("ip:1.1.1.1", 1).allowed).toBe(false);
  });

  it("resets when the window rolls over", () => {
    expect(hitMemory("ip:1.2.3.4", 1).allowed).toBe(true);
    expect(hitMemory("ip:1.2.3.4", 1).allowed).toBe(false);

    vi.setSystemTime(new Date("2026-07-26T12:01:00.000Z"));

    expect(hitMemory("ip:1.2.3.4", 1).allowed).toBe(true);
  });

  it("does not reset partway through a window", () => {
    expect(hitMemory("ip:1.2.3.4", 1).allowed).toBe(true);

    vi.setSystemTime(new Date("2026-07-26T12:00:59.999Z"));

    expect(hitMemory("ip:1.2.3.4", 1).allowed).toBe(false);
  });

  it("reports the seconds left in the window, never zero", () => {
    expect(hitMemory("ip:1.2.3.4", 1).retryAfterSeconds).toBe(60);

    vi.setSystemTime(new Date("2026-07-26T12:00:30.000Z"));
    expect(hitMemory("ip:5.6.7.8", 1).retryAfterSeconds).toBe(30);

    // A caller arriving in the final milliseconds must still be told to wait a
    // whole second, or it retries immediately and is denied again.
    vi.setSystemTime(new Date("2026-07-26T12:00:59.999Z"));
    expect(hitMemory("ip:9.9.9.9", 1).retryAfterSeconds).toBe(1);
  });

  it("treats a limit of one as one request, not two", () => {
    expect(hitMemory("ip:1.2.3.4", 1).allowed).toBe(true);
    expect(hitMemory("ip:1.2.3.4", 1).allowed).toBe(false);
  });
});

describe("which routes get the tight credential budget", () => {
  it("covers the routes that accept a password", () => {
    expect(CREDENTIAL_ROUTES.has("/api/auth/signin")).toBe(true);
    expect(CREDENTIAL_ROUTES.has("/api/auth/signup")).toBe(true);
  });

  it("excludes session reads, which a normal user hits on every page", () => {
    // /api/auth/me on a 10/min budget logs a real user out after eleven page
    // views. That is a lockout caused by the defence rather than by an attack,
    // and it is the reason this is an exact-path set and not a prefix match.
    expect(CREDENTIAL_ROUTES.has("/api/auth/me")).toBe(false);
    expect(CREDENTIAL_ROUTES.has("/api/auth/signout")).toBe(false);
    expect(CREDENTIAL_ROUTES.has("/api/auth/orgs/switch")).toBe(false);
  });

  it("matches exactly, so a suffix cannot slip past the tight budget", () => {
    expect(CREDENTIAL_ROUTES.has("/api/auth/signin/../me")).toBe(false);
    expect(CREDENTIAL_ROUTES.has("/api/auth/signin2")).toBe(false);
  });
});

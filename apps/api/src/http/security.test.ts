import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { onError } from "./middleware.js";
import {
  bodyGuard,
  corsMiddleware,
  DEFAULT_BODY_LIMIT_BYTES,
  securityHeaders,
  WEBHOOK_BODY_LIMIT_BYTES,
} from "./security.js";

/**
 * The edge is only worth having if it behaves the same on the paths nobody
 * demos: a hostile origin, an oversized body, an error response.
 */

function edgeApp() {
  const app = new Hono();
  app.use("*", securityHeaders);
  app.use("*", corsMiddleware);
  app.use("*", bodyGuard);
  app.onError(onError);
  app.get("/health", (c) => c.json({ ok: true }));
  app.post("/gate", (c) => c.json({ ok: true }));
  app.post("/webhooks/github", (c) => c.json({ ok: true }));
  return app;
}

describe("security headers", () => {
  it("carries HSTS, nosniff and a no-load CSP on a normal response", async () => {
    const res = await edgeApp().request("/health");

    expect(res.headers.get("strict-transport-security")).toBe(
      "max-age=15552000; includeSubDomains",
    );
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(res.headers.get("content-security-policy")).toContain(
      "frame-ancestors 'none'",
    );
  });

  it("still carries them on an error response", async () => {
    const app = edgeApp();
    app.get("/boom", () => {
      throw new Error("kaboom");
    });

    const res = await app.request("/boom");

    expect(res.status).toBe(500);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("strict-transport-security")).not.toBeNull();
  });
});

describe("cors", () => {
  it("allows the configured web origin with credentials", async () => {
    const res = await edgeApp().request("/health", {
      headers: { Origin: "http://localhost:3000" },
    });

    expect(res.headers.get("access-control-allow-origin")).toBe("http://localhost:3000");
    expect(res.headers.get("access-control-allow-credentials")).toBe("true");
  });

  it("gives a hostile origin no allow-origin header at all", async () => {
    const res = await edgeApp().request("/health", {
      headers: { Origin: "https://evil.example" },
    });

    // Not "returns evil.example", not "returns *" — returns nothing, so the
    // browser refuses to hand the response to the calling page.
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("never answers with a wildcard", async () => {
    const res = await edgeApp().request("/health", {
      headers: { Origin: "http://localhost:3000" },
    });

    expect(res.headers.get("access-control-allow-origin")).not.toBe("*");
  });
});

describe("body limits", () => {
  it("rejects an oversized body as problem details, not bare text", async () => {
    const res = await edgeApp().request("/gate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "x".repeat(DEFAULT_BODY_LIMIT_BYTES + 1),
    });

    expect(res.status).toBe(413);
    expect(res.headers.get("content-type")).toContain("application/problem+json");

    const body = (await res.json()) as { type: string; status: number };
    expect(body.type).toBe("https://sadhak.online/errors/payload-too-large");
    expect(body.status).toBe(413);
  });

  it("accepts a body under the limit", async () => {
    const res = await edgeApp().request("/gate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "x".repeat(1024),
    });

    expect(res.status).toBe(200);
  });

  it("lets webhook ingress carry a payload the global cap would reject", async () => {
    const res = await edgeApp().request("/webhooks/github", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "x".repeat(DEFAULT_BODY_LIMIT_BYTES + 1),
    });

    expect(res.status).toBe(200);
  });

  it("still caps webhook ingress at its own ceiling", async () => {
    const res = await edgeApp().request("/webhooks/github", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "x".repeat(WEBHOOK_BODY_LIMIT_BYTES + 1),
    });

    expect(res.status).toBe(413);
  });
});

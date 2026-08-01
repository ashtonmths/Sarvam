import { Writable } from "node:stream";
import { type Logger, pino } from "pino";
import { describe, expect, it } from "vitest";
import { withLogContext } from "./log.js";

/**
 * Redaction is a security control, so it gets tested like one: build a logger
 * with the same configuration the real one uses, write to a buffer, and assert
 * the secret is not in the bytes. Asserting on a field name would pass while
 * the value leaked through a differently-named key.
 */

const REDACTED = [
  "password",
  "*.password",
  "token",
  "*.token",
  "secret",
  "*.secret",
  "apiKey",
  "*.apiKey",
  "credential",
  "*.credential",
  "authorization",
  "*.authorization",
  "cookie",
  "*.cookie",
  "req.headers.authorization",
  "req.headers.cookie",
  "req.headers['x-api-key']",
  "DATABASE_URL",
  "*.DATABASE_URL",
  "CREDENTIAL_MASTER_KEY",
  "*.CREDENTIAL_MASTER_KEY",
  "SESSION_SECRET",
  "*.SESSION_SECRET",
  "OPENROUTER_API_KEY",
  "*.OPENROUTER_API_KEY",
];

function capture(write: (logger: Logger) => void): string {
  let output = "";
  const sink = new Writable({
    write(chunk, _encoding, callback) {
      output += String(chunk);
      callback();
    },
  });

  const logger = pino(
    { level: "info", redact: { paths: REDACTED, censor: "[Redacted]" } },
    sink,
  );
  write(logger);
  return output;
}

const SECRET = "hunter2-do-not-log-me";

describe("log redaction", () => {
  it.each([
    "password",
    "token",
    "secret",
    "apiKey",
    "credential",
    "authorization",
    "cookie",
    "DATABASE_URL",
    "CREDENTIAL_MASTER_KEY",
    "SESSION_SECRET",
    "OPENROUTER_API_KEY",
  ])("keeps a top-level %s out of the output", (field) => {
    const output = capture((logger) => {
      logger.info({ [field]: SECRET });
    });

    expect(output).not.toContain(SECRET);
    expect(output).toContain("[Redacted]");
  });

  it.each(["password", "token", "secret", "apiKey", "credential"])(
    "keeps a nested %s out of the output",
    (field) => {
      const output = capture((logger) => {
        logger.info({ connector: { [field]: SECRET } });
      });

      expect(output).not.toContain(SECRET);
    },
  );

  it("redacts request auth headers", () => {
    const output = capture((logger) => {
      logger.info({
        req: {
          headers: {
            authorization: `Bearer ${SECRET}`,
            cookie: `sadhak_session=${SECRET}`,
            "x-api-key": SECRET,
          },
        },
      });
    });

    expect(output).not.toContain(SECRET);
  });

  it("still logs the fields that are not secret", () => {
    const output = capture((logger) => {
      logger.info({ event: "http_request", status: 200, path: "/api/graph/nodes" });
    });

    expect(output).toContain("http_request");
    expect(output).toContain("/api/graph/nodes");
  });
});

describe("ambient log context", () => {
  it("carries the request id across an await", async () => {
    // The whole point: a failure several frames deep is still attributable
    // without threading a logger through every signature.
    const seen = await withLogContext({ requestId: "req-abc" }, async () => {
      await Promise.resolve();
      const { log } = await import("./log.js");
      return log().bindings().requestId as string | undefined;
    });

    expect(seen).toBe("req-abc");
  });

  it("has no context outside a request", async () => {
    const { log } = await import("./log.js");

    expect(log().bindings().requestId).toBeUndefined();
  });

  it("merges nested context rather than replacing it", async () => {
    const { log } = await import("./log.js");

    // A job running inside a request must not lose the request id when it
    // adds its own org id, or the two halves of one story stop joining up.
    const seen = withLogContext({ requestId: "req-abc" }, () =>
      withLogContext({ orgId: 7 }, () => log().bindings()),
    );

    expect(seen.requestId).toBe("req-abc");
    expect(seen.orgId).toBe(7);
  });

  it("does not leak context out of its scope", async () => {
    const { log } = await import("./log.js");

    withLogContext({ requestId: "req-inner" }, () => log().bindings());

    expect(log().bindings().requestId).toBeUndefined();
  });
});

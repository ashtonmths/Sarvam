import type { MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { secureHeaders } from "hono/secure-headers";
import { config } from "../config.js";
import { UserError } from "../errors.js";

/**
 * The API edge. Traefik terminates TLS and nothing else; every other piece of
 * armor a response carries is set here, mounted before anything that can throw
 * so an error path is as hardened as a success path.
 */

/**
 * 256 KB. The largest legitimate body this API takes is a gate request
 * carrying a change descriptor and a handful of identifiers, which is
 * kilobytes. Anything approaching this ceiling is a bug or an attack.
 */
export const DEFAULT_BODY_LIMIT_BYTES = 256 * 1024;

/**
 * 5 MB for vendor ingress. Airtable pings are bytes and GitHub PR events are
 * tens of KB, but a pathological push event with hundreds of commits is
 * genuinely large — and rejecting a real delivery costs us a gate decision,
 * while accepting 5 MB costs a buffer we already bounded.
 */
export const WEBHOOK_BODY_LIMIT_BYTES = 5 * 1024 * 1024;

const SHARED_HEADERS = {
  strictTransportSecurity: "max-age=15552000; includeSubDomains",
  xContentTypeOptions: "nosniff",
  referrerPolicy: "no-referrer",
  xFrameOptions: "DENY",
  // Irrelevant to a JSON API and actively awkward for cross-origin fetches
  // from the web app, which is a different origin by design.
  crossOriginEmbedderPolicy: false,
  crossOriginResourcePolicy: false,
  crossOriginOpenerPolicy: false,
} as const;

/**
 * `Strict-Transport-Security` covers api/n8n subdomains because all of them
 * are TLS. The CSP is the one an API that serves no HTML should carry: it can
 * load nothing and be framed by no one, so an XSS-shaped bug in a JSON error
 * body has no reachable sink.
 */
const strictHeaders = secureHeaders({
  ...SHARED_HEADERS,
  contentSecurityPolicy: {
    defaultSrc: ["'none'"],
    frameAncestors: ["'none'"],
    baseUri: ["'none'"],
    formAction: ["'none'"],
  },
});

/**
 * The one exception, and the reason it is an exception rather than a loosening.
 *
 * The OAuth consent screen is the only HTML this API serves, and it is a form:
 * under `form-action 'none'` the browser blocks its own submission, so the
 * grant can never be given. It needs `'self'` — which permits posting back
 * here and nowhere else, so the page still cannot be turned into a way to send
 * a visitor's input to somebody else's server.
 *
 * `style-src 'unsafe-inline'` is for the page's own <style> block. There is no
 * `script-src` at all, so nothing on this page can execute, and every value
 * interpolated into it is HTML-escaped at the point of interpolation.
 */
const consentHeaders = secureHeaders({
  ...SHARED_HEADERS,
  contentSecurityPolicy: {
    defaultSrc: ["'none'"],
    frameAncestors: ["'none'"],
    baseUri: ["'none'"],
    formAction: ["'self'"],
    styleSrc: ["'unsafe-inline'"],
  },
});

/**
 * Chosen per path rather than set once, because `secureHeaders` writes its
 * headers on the way out — a route handler that set its own CSP would simply
 * be overwritten on the unwind, and the exception has to be made here or not
 * at all.
 */
export const securityHeaders: MiddlewareHandler = (c, next) =>
  c.req.path === "/oauth/authorize" ? consentHeaders(c, next) : strictHeaders(c, next);

/**
 * Browser callers only. `WEB_ORIGINS` is an exact-match allowlist with no
 * wildcard and no reflection of the request's own `Origin`, so a hostile page
 * gets no `Access-Control-Allow-Origin` and the browser refuses to hand it the
 * response. Webhook, MCP and gate callers are server-to-server: they never
 * send `Origin`, never need these headers, and are unaffected.
 */
export const corsMiddleware: MiddlewareHandler = cors({
  origin: (origin) => (config.WEB_ORIGINS.includes(origin) ? origin : null),
  credentials: true,
  allowMethods: ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
  allowHeaders: ["content-type", "x-api-key", "authorization", "x-request-id"],
  exposeHeaders: ["x-request-id", "retry-after"],
  maxAge: 600,
});

/**
 * Body cap that surfaces as problem details rather than Hono's bare 413 text,
 * so every rejection on this API has one shape. Thrown, not returned: the
 * shared `onError` is the only thing that renders errors.
 */
export function bodyLimitOf(maxSize: number): MiddlewareHandler {
  return bodyLimit({
    maxSize,
    onError: () => {
      throw new UserError(`Request body exceeds ${maxSize} bytes`, {
        status: 413,
        type: "payload-too-large",
      });
    },
  });
}

const defaultLimiter = bodyLimitOf(DEFAULT_BODY_LIMIT_BYTES);
const webhookLimiter = bodyLimitOf(WEBHOOK_BODY_LIMIT_BYTES);

/**
 * One limiter that picks its own ceiling. Hono runs *every* middleware whose
 * pattern matches, not just the most specific one, so mounting a `/webhooks/*`
 * limiter next to a `*` limiter would apply both and let the smaller cap
 * reject the large deliveries the larger one exists to admit.
 */
export const bodyGuard: MiddlewareHandler = (c, next) =>
  c.req.path.startsWith("/webhooks/") ? webhookLimiter(c, next) : defaultLimiter(c, next);

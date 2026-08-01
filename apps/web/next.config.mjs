/**
 * The web app's edge.
 *
 * The API grew `secureHeaders` in 13.2; the browser app did not, and a DAST
 * baseline scan found that on its first run — no HSTS, no nosniff, no CSP and
 * no Permissions-Policy on any HTML response. The API being armoured says
 * nothing about the origin a customer actually loads in a tab.
 */

/**
 * `'unsafe-inline'` for scripts is an accepted tradeoff, not an oversight.
 * Next inlines its hydration payload, and the alternative is a per-request
 * nonce threaded through middleware. These pages render no user content at
 * all — marketing copy, and an app shell that fetches everything from the API
 * — so the sink an inline-script policy protects against does not exist here.
 * Revisit the moment any page renders something a user typed.
 */
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  // The API is a different origin by design, so it is named rather than
  // implied. Adding an origin here is a reviewed diff, never something
  // discovered when a feature silently stops working.
  `connect-src 'self' ${process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001"}`,
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  // Belt and braces with X-Frame-Options below: frame-ancestors is the modern
  // control, the header is what older browsers still honour.
  "frame-ancestors 'none'",
].join("; ");

const SECURITY_HEADERS = [
  { key: "Content-Security-Policy", value: CSP },
  // Covers the api. and n8n. subdomains, all of which are TLS.
  { key: "Strict-Transport-Security", value: "max-age=15552000; includeSubDomains" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  // strict-origin-when-cross-origin rather than no-referrer: the app links out
  // to Slack threads and GitHub pull requests, and sending the origin lets
  // those hosts see the traffic came from us without leaking which node a
  // person was looking at.
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  // Nothing here uses a camera, a microphone or a location. Saying so stops a
  // future dependency quietly asking for one.
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(), interest-cohort=()",
  },
];

/** @type {import('next').NextConfig} */
export default {
  // Required by the Dockerfile runtime stage.
  output: "standalone",
  outputFileTracingRoot: new URL("../../", import.meta.url).pathname,
  transpilePackages: ["@sadhak/shared"],
  // The version banner is free reconnaissance.
  poweredByHeader: false,
  async headers() {
    return [{ source: "/:path*", headers: SECURITY_HEADERS }];
  },
};

import { withSentryConfig } from "@sentry/nextjs";

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
/**
 * Sentry's ingest origin, derived from the DSN rather than hardcoded.
 *
 * This has to be in `connect-src` or the browser blocks the report and the
 * console message is the only sign — error tracking that looks configured and
 * silently sends nothing. Deriving it from the DSN means enabling Sentry is one
 * variable and not two things that must agree.
 */
const sentryOrigin = (() => {
  const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;
  if (!dsn) return "";
  try {
    return ` ${new URL(dsn).origin}`;
  } catch {
    return "";
  }
})();

const CSP = [
  "default-src 'self'",
  // `unsafe-eval` in development only. Next's Fast Refresh evaluates modules
  // as strings, so the production policy blocks hydration outright and
  // `next dev` renders a page whose buttons never become interactive — with
  // nothing but a CSP violation in the console to explain it. Costing every
  // developer that discovery is not a security win; the policy that ships is
  // unchanged.
  `script-src 'self' 'unsafe-inline'${process.env.NODE_ENV === "development" ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  // The API is a different origin by design, so it is named rather than
  // implied. Adding an origin here is a reviewed diff, never something
  // discovered when a feature silently stops working.
  `connect-src 'self' ${process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001"}${sentryOrigin}`,
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
const nextConfig = {
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

/**
 * Sentry wraps the config only when a DSN exists.
 *
 * `withSentryConfig` otherwise adds its webpack plugin, its instrumentation
 * hooks and a source-map upload step to every build for a destination that is
 * not configured — slower builds and a pile of warnings in exchange for
 * nothing. Same gate as everywhere else: absent means absent.
 */
export default process.env.NEXT_PUBLIC_SENTRY_DSN
  ? withSentryConfig(nextConfig, {
      silent: true,
      // Minified client bundles need maps to be readable. They are uploaded to
      // Sentry during the CI image build and deleted from the public output,
      // so a stack trace is legible to us and the sources are not served.
      widenClientFileUpload: true,
      sourcemaps: { deleteSourcemapsAfterUpload: true },
      // The tunnel would proxy reports through our own origin to dodge ad
      // blockers. Deliberately off: it would also route customer browser data
      // through our server, and the CSP entry above is the honest way to make
      // reports work.
      disableLogger: true,
    })
  : nextConfig;

import * as Sentry from "@sentry/nextjs";

/** Server-side rendering errors. Same posture as the client: errors only. */
Sentry.init({
  dsn: process.env.SENTRY_DSN ?? process.env.NEXT_PUBLIC_SENTRY_DSN,
  enabled: Boolean(process.env.SENTRY_DSN ?? process.env.NEXT_PUBLIC_SENTRY_DSN),
  release: process.env.NEXT_PUBLIC_GIT_SHA ?? "dev",
  tracesSampleRate: 0,
});

/**
 * Next inlines `NEXT_PUBLIC_*` at build time by literal reference, so each var
 * must be named explicitly here rather than read from a computed key. This is
 * the only module in the web app that touches `process.env`.
 */

function readApiUrl(): string {
  const raw = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";
  try {
    // Fail at build time on a malformed value rather than rendering a client
    // that cannot reach anything.
    return new URL(raw).origin;
  } catch {
    throw new Error(`NEXT_PUBLIC_API_URL is not a valid URL: ${raw}`);
  }
}

export const API_URL = readApiUrl();

import { config } from "../config.js";

/**
 * A link back into the web app, built from configuration rather than typed out.
 *
 * Slack alerts and emails carry deep links, and every one of them was written
 * as a literal `https://sadhak.online/...`. On this deployment that happens to
 * be right; on a laptop, a preview environment, or anyone else's install it is
 * a link to somebody else's product. Nothing fails — the message sends, the
 * button renders, and it takes you to the wrong place.
 *
 * WEB_ORIGINS is the same list CORS is enforced against, so the origin a link
 * points at is by construction one the browser is allowed to load. The first
 * entry is the canonical one: the apex is listed before `www.` for exactly this
 * reason.
 */
export function appUrl(path: string): string {
  const origin = (config.WEB_ORIGINS[0] ?? "").replace(/\/$/, "");
  return `${origin}${path.startsWith("/") ? path : `/${path}`}`;
}

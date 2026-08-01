import { emailPreferences } from "@sadhak/shared/schema";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { db } from "../db.js";
import { readUnsubscribeToken } from "../email/unsubscribe.js";
import { UserError } from "../errors.js";

/**
 * Unsubscribe, with no login and no session.
 *
 * RFC 8058's one-click target is a POST from a mail client, made on behalf of
 * somebody who may never open the browser. Requiring authentication there would
 * mean Gmail's unsubscribe button silently does nothing, which is worse than
 * having no button — the user believes they have stopped it and we keep
 * sending.
 *
 * The token carries its own authority, so this route is deliberately
 * unauthenticated. It is idempotent, it cannot be used to read anything, and
 * the worst an attacker with a stolen token can do is stop somebody's digest.
 */
export const commsRoutes = new Hono();

commsRoutes.post("/unsubscribe", async (c) => {
  const token =
    c.req.query("token") ??
    ((await c.req.parseBody().catch(() => ({}))) as { token?: string }).token ??
    "";

  const parsed = readUnsubscribeToken(String(token));
  if (!parsed) throw new UserError("That unsubscribe link is not valid.");

  await db
    .insert(emailPreferences)
    .values({ userId: parsed.userId, category: parsed.category })
    .onConflictDoNothing();

  return c.json({ unsubscribed: true, category: parsed.category });
});

/** The human-facing counterpart, so somebody who changes their mind can. */
commsRoutes.post("/resubscribe", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { token?: string };
  const parsed = readUnsubscribeToken(String(body.token ?? ""));
  if (!parsed) throw new UserError("That link is not valid.");

  await db
    .delete(emailPreferences)
    .where(
      and(
        eq(emailPreferences.userId, parsed.userId),
        eq(emailPreferences.category, parsed.category),
      ),
    );

  return c.json({ resubscribed: true, category: parsed.category });
});

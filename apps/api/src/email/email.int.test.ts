import { emailLog, emailPreferences, organizations, users } from "@sadhak/shared/schema";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closePools, db } from "../db.js";
import { sendMail } from "./mailer.js";
import { readUnsubscribeToken, unsubscribeToken } from "./unsubscribe.js";

/**
 * The mailer's two jobs that are not "send an email": honouring an opt-out,
 * and recording what happened either way.
 *
 * No provider is configured in tests, which is the interesting case rather than
 * a limitation — it is also production's state today, and "does nothing
 * gracefully" is exactly the behaviour that would otherwise break a crawl.
 */

afterAll(async () => {
  await closePools();
});

let userId: number;
let orgId: number;

beforeEach(async () => {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const [org] = await db
    .insert(organizations)
    .values({ name: `mail-${stamp}`, slug: `mail-${stamp}` })
    .returning();
  orgId = org?.id ?? 0;

  const [user] = await db
    .insert(users)
    .values({
      email: `mail-${stamp}@example.com`,
      name: "Mail Test",
      passwordHash: "x",
    })
    .returning();
  userId = user?.id ?? 0;
});

function mail(category: "auth" | "lifecycle" | "digest", template: string) {
  return {
    to: "someone@example.com",
    subject: "s",
    text: "t",
    html: "<p>h</p>",
    category,
    template,
    userId,
    orgId,
  };
}

async function logRows(template: string) {
  return db
    .select()
    .from(emailLog)
    .where(and(eq(emailLog.orgId, orgId), eq(emailLog.template, template)));
}

describe("sendMail", () => {
  it("records a skip rather than throwing when no provider is configured", async () => {
    await expect(sendMail(mail("lifecycle", "noProvider"))).resolves.toBeUndefined();

    const rows = await logRows("noProvider");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.skippedReason).toBe("no_provider");
  });

  it("drops a lifecycle send for someone who opted out", async () => {
    await db.insert(emailPreferences).values({ userId, category: "lifecycle" });

    await sendMail(mail("lifecycle", "optedOut"));

    const rows = await logRows("optedOut");
    expect(rows[0]?.skippedReason).toBe("opted_out");
  });

  it("still sends auth email to someone who opted out of everything else", async () => {
    // The property that stops an unsubscribe from locking somebody out of
    // their own account. `auth` has no preference row by design, so this
    // asserts the category check ignores one even if it exists.
    await db.insert(emailPreferences).values({ userId, category: "lifecycle" });
    await db.insert(emailPreferences).values({ userId, category: "digest" });

    await sendMail(mail("auth", "passwordReset"));

    const rows = await logRows("passwordReset");
    expect(rows[0]?.skippedReason).toBe("no_provider");
    expect(rows[0]?.skippedReason).not.toBe("opted_out");
  });
});

describe("unsubscribe tokens", () => {
  it("round-trips", () => {
    const token = unsubscribeToken(42, "digest");
    expect(readUnsubscribeToken(token)).toEqual({ userId: 42, category: "digest" });
  });

  it("rejects a tampered signature", () => {
    const token = unsubscribeToken(42, "digest");
    const [payload] = token.split(".");
    expect(readUnsubscribeToken(`${payload}.forged`)).toBeNull();
  });

  it("rejects a re-pointed payload", () => {
    // Swapping the user id must invalidate the signature, or one person's
    // unsubscribe link is everyone's.
    const token = unsubscribeToken(42, "digest");
    const [, signature] = token.split(".");
    const forged = `${Buffer.from("99:digest").toString("base64url")}.${signature}`;
    expect(readUnsubscribeToken(forged)).toBeNull();
  });

  it("refuses an auth-category token even if one is forged into shape", () => {
    // `auth` tokens are never minted. Accepting one would be a way to switch
    // off somebody else's password-reset email.
    const token = unsubscribeToken(42, "digest");
    const [, signature] = token.split(".");
    const forged = `${Buffer.from("42:auth").toString("base64url")}.${signature}`;
    expect(readUnsubscribeToken(forged)).toBeNull();
  });

  it("returns null for junk rather than throwing", () => {
    for (const junk of ["", ".", "no-dot", "a.b.c", "%%%.%%%"]) {
      expect(readUnsubscribeToken(junk)).toBeNull();
    }
  });
});

import { emailLog, emailPreferences } from "@sadhak/shared/schema";
import { and, eq } from "drizzle-orm";
import { config } from "../config.js";
import { db } from "../db.js";
import { log } from "../log.js";
import { unsubscribeToken } from "./unsubscribe.js";

/**
 * The only module that sends email.
 *
 * Same isolation rule as `llm.ts`, and for the same reason: preference checks,
 * the unsubscribe headers and the send log all have to happen on *every* send,
 * and the only way to guarantee that is for there to be one door. A grep for
 * the provider must never find a second caller.
 *
 * **Off unless a provider is configured**, exactly like tracing and error
 * reporting. `RESEND_API_KEY` unset means every send is recorded as skipped and
 * nothing leaves — because a lifecycle email that throws on a machine with no
 * mail provider would take down a crawl, and a crawl finishing matters more
 * than an email about it.
 */

export type Category = "auth" | "lifecycle" | "digest";

export interface Mail {
  to: string;
  subject: string;
  text: string;
  html: string;
  category: Category;
  /** Which template produced this, for the log. */
  template: string;
  userId?: number;
  orgId?: number;
}

/**
 * Whether this person still wants this category.
 *
 * `auth` is never suppressible. A verification link or a password reset is not
 * marketing — withholding one because somebody clicked unsubscribe on a digest
 * would lock them out of their own account, which is a worse outcome than the
 * one unsubscribing was meant to avoid.
 */
async function wants(userId: number | undefined, category: Category): Promise<boolean> {
  if (category === "auth" || userId === undefined) return true;

  const rows = await db
    .select({ userId: emailPreferences.userId })
    .from(emailPreferences)
    .where(
      and(eq(emailPreferences.userId, userId), eq(emailPreferences.category, category)),
    )
    .limit(1);

  return rows.length === 0;
}

async function record(mail: Mail, messageId: string | null, skipped: string | null) {
  await db.insert(emailLog).values({
    ...(mail.userId !== undefined ? { userId: mail.userId } : {}),
    ...(mail.orgId !== undefined ? { orgId: mail.orgId } : {}),
    category: mail.category,
    template: mail.template,
    to: mail.to,
    providerMessageId: messageId,
    skippedReason: skipped,
  });
}

/**
 * Sends, or records why it did not. Never throws.
 *
 * Callers are crawl handlers and cron jobs; an email failure must not fail the
 * work that prompted it. Anything that goes wrong is logged and written to
 * `email_log` with a reason, which is the record support reads when someone
 * says they never got it.
 */
export async function sendMail(mail: Mail): Promise<void> {
  try {
    if (!(await wants(mail.userId, mail.category))) {
      await record(mail, null, "opted_out");
      return;
    }

    if (!config.RESEND_API_KEY) {
      // The honest no-op. Logged at debug so a developer can see the body
      // without a provider, and recorded so the absence is visible in the data
      // rather than only in a config file.
      log().debug(
        { event: "email_skipped", template: mail.template, to: mail.to },
        "no mail provider configured",
      );
      await record(mail, null, "no_provider");
      return;
    }

    const headers: Record<string, string> = {};
    if (mail.category !== "auth" && mail.userId !== undefined) {
      // RFC 8058. Gmail and Yahoo require one-click unsubscribe from bulk
      // senders, and the weekly digest is bulk by their definition. The mailto
      // is the fallback for clients that do not do the POST.
      const token = unsubscribeToken(mail.userId, mail.category);
      headers["List-Unsubscribe"] =
        `<https://sadhak.online/unsubscribe?token=${token}>, <mailto:unsub@sadhak.online>`;
      headers["List-Unsubscribe-Post"] = "List-Unsubscribe=One-Click";
    }

    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.RESEND_API_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        from: config.MAIL_FROM,
        to: mail.to,
        subject: mail.subject,
        text: mail.text,
        html: mail.html,
        headers,
      }),
      signal: AbortSignal.timeout(15_000),
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      log().warn(
        {
          event: "email_failed",
          template: mail.template,
          status: response.status,
          detail,
        },
        "mail provider rejected the send",
      );
      await record(mail, null, `provider_${response.status}`);
      return;
    }

    const body = (await response.json().catch(() => ({}))) as { id?: string };
    await record(mail, body.id ?? null, null);
    log().info({ event: "email_sent", template: mail.template, category: mail.category });
  } catch (error) {
    log().warn(
      { event: "email_error", template: mail.template, err: error },
      "email send failed",
    );
    await record(mail, null, "error").catch(() => undefined);
  }
}

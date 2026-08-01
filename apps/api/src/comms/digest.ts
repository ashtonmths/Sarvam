import {
  emailLog,
  gateDecisions,
  members,
  organizations,
  rationale,
  reflexIncidents,
  users,
  verdicts,
} from "@sadhak/shared/schema";
import { and, eq, gte, sql } from "drizzle-orm";
import { db } from "../db.js";
import { sendMail } from "../email/mailer.js";
import { weeklyDigest } from "../email/templates.js";
import { log } from "../log.js";

/**
 * The weekly digest, and the rule that keeps it worth opening.
 *
 * **Skip if empty.** An org with no activity gets no email. A digest that
 * arrives every Monday saying nothing happened trains people to delete it
 * unread, and deleting unread becomes unsubscribing — so the quiet weeks are
 * exactly the ones not to send.
 *
 * Coverage counts human-confirmed rationale only. Drafts an agent proposed and
 * nobody reviewed are not in the number, here or anywhere else.
 */

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

interface Week {
  gated: number;
  blocked: number;
  reverts: number;
  coverageDelta: number;
  pendingDrafts: number;
  staleCorrections: number;
}

async function weekFor(orgId: number, since: Date): Promise<Week> {
  const [decisions] = await db
    .select({
      gated: sql<number>`count(*)::int`,
      blocked: sql<number>`count(*) FILTER (WHERE ${verdicts.verdict} = 'BLOCK')::int`,
    })
    .from(gateDecisions)
    .innerJoin(verdicts, eq(verdicts.id, gateDecisions.verdictId))
    .where(and(eq(gateDecisions.orgId, orgId), gte(gateDecisions.createdAt, since)));

  const [reverted] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(reflexIncidents)
    .where(
      and(
        eq(reflexIncidents.orgId, orgId),
        eq(reflexIncidents.state, "reverted"),
        gte(reflexIncidents.createdAt, since),
      ),
    );

  const [confirmed] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(rationale)
    .where(
      and(
        eq(rationale.orgId, orgId),
        eq(rationale.state, "confirmed"),
        gte(rationale.confirmedAt, since),
      ),
    );

  const [pending] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(rationale)
    .where(and(eq(rationale.orgId, orgId), eq(rationale.state, "drafted")));

  const [stale] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(rationale)
    .where(
      and(
        eq(rationale.orgId, orgId),
        eq(rationale.state, "drafted"),
        sql`${rationale.createdAt} < now() - interval '72 hours'`,
      ),
    );

  return {
    gated: decisions?.gated ?? 0,
    blocked: decisions?.blocked ?? 0,
    reverts: reverted?.n ?? 0,
    coverageDelta: confirmed?.n ?? 0,
    pendingDrafts: pending?.n ?? 0,
    staleCorrections: stale?.n ?? 0,
  };
}

/** Nothing happened and nothing is waiting: do not write to anybody. */
function worthSending(week: Week): boolean {
  return (
    week.gated > 0 ||
    week.reverts > 0 ||
    week.coverageDelta > 0 ||
    week.staleCorrections > 0
  );
}

/** One per org per week. Returns how many were actually sent. */
export async function sendWeeklyDigests(): Promise<number> {
  const since = new Date(Date.now() - WEEK_MS);
  const orgs = await db
    .select({ id: organizations.id, name: organizations.name })
    .from(organizations);

  let sent = 0;
  for (const org of orgs) {
    const week = await weekFor(org.id, since);
    if (!worthSending(week)) continue;

    // Idempotent against a retried job or a second worker: one digest per org
    // per week, guarded on the log rather than on a flag.
    const [already] = await db
      .select({ id: emailLog.id })
      .from(emailLog)
      .where(
        and(
          eq(emailLog.orgId, org.id),
          eq(emailLog.template, "weeklyDigest"),
          gte(emailLog.sentAt, since),
        ),
      )
      .limit(1);
    if (already) continue;

    const recipients = await db
      .select({ id: users.id, email: users.email })
      .from(members)
      .innerJoin(users, eq(users.id, members.userId))
      .where(and(eq(members.orgId, org.id), eq(members.role, "owner")));

    for (const person of recipients) {
      const rendered = weeklyDigest({ orgName: org.name, ...week });
      await sendMail({
        ...rendered,
        to: person.email,
        category: "digest",
        template: "weeklyDigest",
        userId: person.id,
        orgId: org.id,
      });
      sent++;
    }
  }

  log().info({ event: "weekly_digests", orgs: orgs.length, sent });
  return sent;
}

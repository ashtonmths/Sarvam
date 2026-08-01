import { createHash, randomBytes } from "node:crypto";
import type { Role } from "@sadhak/shared/rbac";
import { members, organizations, sessions, users } from "@sadhak/shared/schema";
import { and, eq, gt, isNull, lt, or } from "drizzle-orm";
import { db } from "../db.js";

/**
 * Opaque bearer tokens. Only the SHA-256 of a token is stored, so a leaked
 * database backup yields nothing usable.
 */

export const SESSION_COOKIE = "sadhak_session";
export const SESSION_TTL_DAYS = 7;

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function mintToken(): string {
  return randomBytes(32).toString("base64url");
}

export interface SessionActor {
  sessionId: number;
  userId: number;
  email: string;
  name: string;
  orgId: number | null;
  role: Role | null;
}

export async function createSession(
  userId: number,
  orgId: number | null,
  meta: { userAgent?: string | undefined; ip?: string | undefined } = {},
): Promise<{ token: string; expiresAt: Date }> {
  const token = mintToken();
  const expiresAt = new Date(Date.now() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000);

  await db.insert(sessions).values({
    tokenHash: hashToken(token),
    userId,
    orgId,
    userAgent: meta.userAgent ?? null,
    ip: meta.ip ?? null,
    expiresAt,
  });

  return { token, expiresAt };
}

/** Resolves a cookie token to an actor, or null. Expired rows never match. */
export async function resolveSession(token: string): Promise<SessionActor | null> {
  const [row] = await db
    .select({
      sessionId: sessions.id,
      userId: users.id,
      email: users.email,
      name: users.name,
      orgId: sessions.orgId,
      role: members.role,
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .leftJoin(
      members,
      and(eq(members.userId, sessions.userId), eq(members.orgId, sessions.orgId)),
    )
    .where(
      and(eq(sessions.tokenHash, hashToken(token)), gt(sessions.expiresAt, new Date())),
    )
    .limit(1);

  if (!row) return null;

  // A session whose active org was never set falls back to any membership, so
  // a fresh signin lands somewhere usable instead of an org-less dead end.
  if (row.orgId === null) {
    const [membership] = await db
      .select({ orgId: members.orgId, role: members.role })
      .from(members)
      .where(eq(members.userId, row.userId))
      .limit(1);
    if (membership) {
      await db
        .update(sessions)
        .set({ orgId: membership.orgId })
        .where(eq(sessions.id, row.sessionId));
      return { ...row, orgId: membership.orgId, role: membership.role };
    }
  }

  return { ...row, role: row.role ?? null };
}

export async function touchSession(sessionId: number): Promise<void> {
  await db
    .update(sessions)
    .set({ lastSeenAt: new Date() })
    .where(eq(sessions.id, sessionId));
}

export async function revokeSession(sessionId: number, userId: number): Promise<void> {
  await db
    .delete(sessions)
    .where(and(eq(sessions.id, sessionId), eq(sessions.userId, userId)));
}

export async function revokeSessionByToken(token: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.tokenHash, hashToken(token)));
}

export async function listSessions(userId: number) {
  return db
    .select({
      id: sessions.id,
      userAgent: sessions.userAgent,
      ip: sessions.ip,
      lastSeenAt: sessions.lastSeenAt,
      createdAt: sessions.createdAt,
    })
    .from(sessions)
    .where(eq(sessions.userId, userId))
    .orderBy(sessions.lastSeenAt);
}

/** Switching orgs writes the active org onto the session row. */
export async function setActiveOrg(sessionId: number, orgId: number): Promise<void> {
  await db.update(sessions).set({ orgId }).where(eq(sessions.id, sessionId));
}

export async function listMemberships(userId: number) {
  return db
    .select({
      orgId: organizations.id,
      publicId: organizations.publicId,
      name: organizations.name,
      slug: organizations.slug,
      role: members.role,
    })
    .from(members)
    .innerJoin(organizations, eq(organizations.id, members.orgId))
    .where(eq(members.userId, userId));
}

/** Retention: expired sessions are exhaust, pruned by the jobs worker. */
export async function pruneExpiredSessions(): Promise<void> {
  await db
    .delete(sessions)
    .where(or(lt(sessions.expiresAt, new Date()), isNull(sessions.expiresAt)));
}

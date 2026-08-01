import { capabilitiesFor } from "@sadhak/shared/rbac";
import { auditLog, invitations, members, users } from "@sadhak/shared/schema";
import { and, desc, eq, lt, or } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { audit } from "../audit.js";
import { createApiKey, listApiKeys, revokeApiKey } from "../auth/api-keys.js";
import { listSessions, revokeSession } from "../auth/session.js";
import { db } from "../db.js";
import { ForbiddenError, NotFoundError, UserError } from "../errors.js";
import { paginated, parsePagination } from "../http/pagination.js";
import { actorRole, requireCapability } from "../middleware/auth.js";
import { parseScopes } from "./auth.js";

/**
 * Org administration. Mounted inside the authenticated, org-scoped group, so
 * every handler here already has a resolved org and never reads one from input.
 */
export const orgRoutes = new Hono();

/* ------------------------------------------------------------- members */

orgRoutes.get("/members", requireCapability("graph:read"), async (c) => {
  const orgId = c.get("orgId");
  const rows = await db
    .select({
      id: members.id,
      userId: users.id,
      name: users.name,
      email: users.email,
      role: members.role,
      joinedAt: members.createdAt,
    })
    .from(members)
    .innerJoin(users, eq(users.id, members.userId))
    .where(eq(members.orgId, orgId))
    .orderBy(members.createdAt);
  return c.json({ items: rows });
});

orgRoutes.post("/members/invite", requireCapability("member:manage"), async (c) => {
  const orgId = c.get("orgId");
  const body = z
    .object({
      email: z.string().email(),
      role: z.enum(["admin", "member", "viewer"]),
    })
    .parse(await c.req.json());

  const actor = c.get("actor");
  const token = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

  const [row] = await db
    .insert(invitations)
    .values({
      orgId,
      email: body.email.toLowerCase(),
      role: body.role,
      tokenHash: token,
      invitedBy: actor.type === "user" ? actor.id : null,
      expiresAt,
    })
    .returning({ id: invitations.id });

  await audit(
    c,
    "member.invited",
    { kind: "invitation", id: row?.id ?? 0 },
    {
      email: body.email,
      role: body.role,
    },
  );

  // ADR 0002: no mailer exists in this build, so the acceptance link is
  // returned to the inviter to hand over rather than silently dropped.
  return c.json(
    { id: row?.id, email: body.email, role: body.role, expiresAt, inviteToken: token },
    201,
  );
});

orgRoutes.patch("/members/:memberId", requireCapability("member:manage"), async (c) => {
  const orgId = c.get("orgId");
  const memberId = Number(c.req.param("memberId"));
  const { role } = z
    .object({ role: z.enum(["admin", "member", "viewer"]) })
    .parse(await c.req.json());

  const [target] = await db
    .select({ id: members.id, role: members.role })
    .from(members)
    .where(and(eq(members.id, memberId), eq(members.orgId, orgId)))
    .limit(1);
  if (!target) throw new NotFoundError();

  // Admins cannot touch owners. The UI encodes it; this is what enforces it.
  const role_ = await actorRole(c.get("actor"), orgId);
  if (target.role === "owner" && role_ !== "owner") {
    throw new ForbiddenError("Only an owner can change an owner's role");
  }

  await db.update(members).set({ role }).where(eq(members.id, memberId));
  await audit(c, "member.role_changed", { kind: "member", id: memberId }, { role });
  return c.json({ ok: true });
});

orgRoutes.delete("/members/:memberId", requireCapability("member:manage"), async (c) => {
  const orgId = c.get("orgId");
  const memberId = Number(c.req.param("memberId"));

  const [target] = await db
    .select({ role: members.role })
    .from(members)
    .where(and(eq(members.id, memberId), eq(members.orgId, orgId)))
    .limit(1);
  if (!target) throw new NotFoundError();
  if (target.role === "owner") {
    throw new ForbiddenError("Transfer ownership before removing an owner");
  }

  await db.delete(members).where(eq(members.id, memberId));
  await audit(c, "member.removed", { kind: "member", id: memberId });
  return c.json({ ok: true });
});

/* ------------------------------------------------------------ api keys */

orgRoutes.get("/api-keys", requireCapability("apikey:manage"), async (c) => {
  return c.json({ items: await listApiKeys(c.get("orgId")) });
});

orgRoutes.post("/api-keys", requireCapability("apikey:manage"), async (c) => {
  const orgId = c.get("orgId");
  const actor = c.get("actor");
  if (actor.type !== "user") {
    throw new ForbiddenError("API keys cannot mint other API keys");
  }

  const body = z
    .object({ name: z.string().min(1).max(80), scopes: z.unknown() })
    .parse(await c.req.json());
  const requested = parseScopes(body.scopes);

  // A key may never grant more than its creator holds.
  const role = await actorRole(actor, orgId);
  const held = role && role !== "api_key" ? capabilitiesFor(role) : [];
  const excess = requested.filter((s) => !held.includes(s));
  if (excess.length > 0) {
    throw new ForbiddenError(
      `You cannot grant capabilities you lack: ${excess.join(", ")}`,
    );
  }

  const created = await createApiKey({
    orgId,
    name: body.name,
    scopes: requested,
    createdBy: actor.id,
  });
  await audit(
    c,
    "apikey.created",
    { kind: "api_key", id: created.id },
    {
      scopes: requested,
    },
  );

  // The full key exists in exactly this response and nowhere else, ever again.
  return c.json(created, 201);
});

orgRoutes.delete("/api-keys/:keyId", requireCapability("apikey:manage"), async (c) => {
  const keyId = Number(c.req.param("keyId"));
  const revoked = await revokeApiKey(c.get("orgId"), keyId);
  if (!revoked) throw new NotFoundError();
  await audit(c, "apikey.revoked", { kind: "api_key", id: keyId });
  return c.json({ ok: true });
});

/* ------------------------------------------------------------- sessions */

orgRoutes.get("/sessions", async (c) => {
  const actor = c.get("actor");
  if (actor.type !== "user") throw new ForbiddenError("Sessions belong to users");
  return c.json({ items: await listSessions(actor.id) });
});

orgRoutes.delete("/sessions/:sessionId", async (c) => {
  const actor = c.get("actor");
  if (actor.type !== "user") throw new ForbiddenError("Sessions belong to users");
  const sessionId = Number(c.req.param("sessionId"));
  await revokeSession(sessionId, actor.id);
  await audit(c, "auth.session_revoked", { kind: "session", id: sessionId });
  return c.json({ ok: true });
});

/* ------------------------------------------------------------ audit log */

orgRoutes.get("/audit", requireCapability("audit:read"), async (c) => {
  const orgId = c.get("orgId");
  const { limit, cursor } = parsePagination(c.req.query());

  const rows = await db
    .select()
    .from(auditLog)
    .where(
      cursor
        ? and(
            eq(auditLog.orgId, orgId),
            or(
              lt(auditLog.createdAt, new Date(cursor.k)),
              and(eq(auditLog.createdAt, new Date(cursor.k)), lt(auditLog.id, cursor.i)),
            ),
          )
        : eq(auditLog.orgId, orgId),
    )
    .orderBy(desc(auditLog.createdAt), desc(auditLog.id))
    .limit(limit + 1);

  return c.json(
    paginated(rows, limit, (row) => ({ k: row.createdAt.toISOString(), i: row.id })),
  );
});

export function assertPositiveInt(value: string | undefined, label: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new UserError(`${label} must be a positive integer`);
  }
  return parsed;
}

import type { Capability, Role } from "@sadhak/shared/rbac";
import { roleHas } from "@sadhak/shared/rbac";
import { members } from "@sadhak/shared/schema";
import { and, eq } from "drizzle-orm";
import { getCookie } from "hono/cookie";
import { createMiddleware } from "hono/factory";
import { audit } from "../audit.js";
import { verifyApiKey } from "../auth/api-keys.js";
import { resolveSession, SESSION_COOKIE, touchSession } from "../auth/session.js";
import { db } from "../db.js";
import { ForbiddenError, NotFoundError, UnauthorizedError } from "../errors.js";
import { getOrgByPublicId, type OrgDb, orgDb } from "../tenant.js";

/**
 * Three composable layers every route uses. Handlers receive only the
 * org-scoped handle, so forgetting a `WHERE org_id =` is structurally
 * impossible rather than a review item.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type Actor =
  | { type: "user"; id: number; sessionId: number; email: string; role: Role | null }
  | { type: "api_key"; id: number; scopes: Capability[] };

declare module "hono" {
  interface ContextVariableMap {
    requestId: string;
    actor: Actor;
    orgId: number;
    orgDb: OrgDb;
  }
}

/** Session cookie OR API key → sets actor on context. */
export const requireAuth = createMiddleware(async (c, next) => {
  const bearer = c.req.header("authorization")?.replace(/^Bearer\s+/i, "");
  const apiKey = c.req.header("x-api-key") ?? bearer;

  if (apiKey) {
    const keyActor = await verifyApiKey(apiKey);
    if (!keyActor) throw new UnauthorizedError("Invalid API key");
    c.set("actor", { type: "api_key", id: keyActor.keyId, scopes: keyActor.scopes });
    c.set("orgId", keyActor.orgId);
    await next();
    return;
  }

  const token = getCookie(c, SESSION_COOKIE);
  if (!token) throw new UnauthorizedError();

  const session = await resolveSession(token);
  if (!session) throw new UnauthorizedError("Session expired");

  void touchSession(session.sessionId);
  c.set("actor", {
    type: "user",
    id: session.userId,
    sessionId: session.sessionId,
    email: session.email,
    role: session.role,
  });
  if (session.orgId !== null) c.set("orgId", session.orgId);
  await next();
});

/**
 * Resolves the org from the credential and binds the scoped handle.
 *
 * When a route carries an org identifier in its path, it is asserted against
 * the credential-resolved org and a mismatch is a 404 — a wrong org id must be
 * indistinguishable from one that does not exist. The path segment is a
 * readability affordance and an assertion target, never a lookup key.
 */
export const requireOrg = createMiddleware(async (c, next) => {
  const orgId = c.get("orgId");
  if (orgId === undefined) {
    throw new ForbiddenError("No active organization — create or join one first");
  }

  const pathOrg = c.req.param("orgId");
  if (pathOrg !== undefined) {
    let resolved: number | null;
    if (/^\d+$/.test(pathOrg)) {
      resolved = Number(pathOrg);
    } else if (UUID.test(pathOrg)) {
      resolved = (await getOrgByPublicId(pathOrg))?.id ?? null;
    } else {
      // The column is uuid-typed, so handing it a malformed segment raises a
      // Postgres cast error rather than returning no rows. Shape-check first:
      // an unparseable id is simply one that does not exist.
      resolved = null;
    }
    if (resolved !== orgId) throw new NotFoundError();
  }

  c.set("orgDb", orgDb(orgId));
  await next();
});

/** Role (for users) or key scope (for API keys) → capability check. */
export function requireCapability(capability: Capability) {
  return createMiddleware(async (c, next) => {
    const actor = c.get("actor");
    const orgId = c.get("orgId");

    let allowed = false;
    if (actor.type === "api_key") {
      allowed = actor.scopes.includes(capability);
    } else {
      const role = actor.role ?? (await roleOf(actor.id, orgId));
      allowed = role !== null && roleHas(role, capability);
    }

    if (!allowed) {
      await audit(c, "rbac.denied", { kind: "capability", id: capability });
      throw new ForbiddenError(`This action requires the "${capability}" capability`);
    }
    await next();
  });
}

async function roleOf(userId: number, orgId: number): Promise<Role | null> {
  const [row] = await db
    .select({ role: members.role })
    .from(members)
    .where(and(eq(members.userId, userId), eq(members.orgId, orgId)))
    .limit(1);
  return row?.role ?? null;
}

/** The acting user's role in the active org, for routes that need it. */
export async function actorRole(
  actor: Actor,
  orgId: number,
): Promise<Role | "api_key" | null> {
  if (actor.type === "api_key") return "api_key";
  return actor.role ?? (await roleOf(actor.id, orgId));
}

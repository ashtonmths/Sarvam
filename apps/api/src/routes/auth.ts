import { type Capability, capabilitiesFor, isCapability } from "@sadhak/shared/rbac";
import { members, organizations, users } from "@sadhak/shared/schema";
import { eq } from "drizzle-orm";
import { type Context, Hono } from "hono";
import { deleteCookie, setCookie } from "hono/cookie";
import { z } from "zod";
import { audit, clientIp } from "../audit.js";
import { hashPassword, passwordProblem, verifyPassword } from "../auth/password.js";
import {
  createSession,
  listMemberships,
  revokeSessionByToken,
  SESSION_COOKIE,
  SESSION_TTL_DAYS,
  setActiveOrg,
} from "../auth/session.js";
import { isProd } from "../config.js";
import { db } from "../db.js";
import { ConflictError, UnauthorizedError, UserError } from "../errors.js";
import { requireAuth } from "../middleware/auth.js";
import { slugify } from "../tenant.js";
import { signinSchema, signupSchema } from "./auth.schemas.js";

export const authRoutes = new Hono();

function issueCookie(c: Context, token: string) {
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    secure: isProd,
    sameSite: "Lax",
    path: "/",
    maxAge: SESSION_TTL_DAYS * 24 * 60 * 60,
  });
}

/**
 * Signup creates the user, their first org, and an owner membership in one
 * transaction — a user with an account but no org is a dead end, not a state
 * worth representing.
 */
authRoutes.post("/signup", async (c) => {
  const body = signupSchema.parse(await c.req.json());

  const problem = passwordProblem(body.password);
  if (problem) throw new UserError(problem);

  const email = body.email.toLowerCase().trim();
  const existing = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, email))
    .limit(1);
  if (existing.length > 0) {
    throw new ConflictError("An account with that email already exists");
  }

  const passwordHash = await hashPassword(body.password);
  const orgName = body.company?.trim() || `${body.name.split(" ")[0]}'s workspace`;

  const { userId, orgId } = await db.transaction(async (tx) => {
    const [user] = await tx
      .insert(users)
      .values({
        email,
        name: body.name.trim(),
        passwordHash,
        // ADR 0002: no verification email exists in this build, so the address
        // is trusted on signup. Plan 4 §4.2 is the remediation.
        emailVerifiedAt: new Date(),
      })
      .returning({ id: users.id });

    const [org] = await tx
      .insert(organizations)
      .values({ name: orgName, slug: await uniqueSlug(orgName) })
      .returning({ id: organizations.id });

    await tx
      .insert(members)
      .values({ orgId: org?.id ?? 0, userId: user?.id ?? 0, role: "owner" });

    return { userId: user?.id ?? 0, orgId: org?.id ?? 0 };
  });

  const { token } = await createSession(userId, orgId, {
    userAgent: c.req.header("user-agent"),
    ip: clientIp(c) ?? undefined,
  });
  issueCookie(c, token);

  c.set("actor", { type: "user", id: userId, sessionId: 0, email, role: "owner" });
  c.set("orgId", orgId);
  await audit(c, "auth.signup", { kind: "user", id: userId });

  return c.json({ user: { id: userId, email, name: body.name }, orgId }, 201);
});

authRoutes.post("/signin", async (c) => {
  const body = signinSchema.parse(await c.req.json());
  const email = body.email.toLowerCase().trim();

  const [user] = await db
    .select({
      id: users.id,
      email: users.email,
      name: users.name,
      passwordHash: users.passwordHash,
    })
    .from(users)
    .where(eq(users.email, email))
    .limit(1);

  // Same response and roughly the same work either way: never confirm which
  // half of the pair was wrong.
  const ok = user ? await verifyPassword(body.password, user.passwordHash) : false;
  if (!user || !ok) throw new UnauthorizedError("Invalid email or password");

  const [membership] = await listMemberships(user.id);
  const { token } = await createSession(user.id, membership?.orgId ?? null, {
    userAgent: c.req.header("user-agent"),
    ip: clientIp(c) ?? undefined,
  });
  issueCookie(c, token);

  c.set("actor", {
    type: "user",
    id: user.id,
    sessionId: 0,
    email: user.email,
    role: membership?.role ?? null,
  });
  if (membership) c.set("orgId", membership.orgId);
  await audit(c, "auth.signin", { kind: "user", id: user.id });

  return c.json({
    user: { id: user.id, email: user.email, name: user.name },
    orgId: membership?.orgId ?? null,
  });
});

authRoutes.post("/signout", async (c) => {
  const token = c.req.header("cookie")?.match(/sadhak_session=([^;]+)/)?.[1];
  if (token) await revokeSessionByToken(decodeURIComponent(token));
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
  return c.json({ ok: true });
});

/** Who am I, which orgs can I see, and what may I do in the active one. */
authRoutes.get("/me", requireAuth, async (c) => {
  const actor = c.get("actor");
  if (actor.type === "api_key") {
    return c.json({
      actor: { type: "api_key", id: actor.id, scopes: actor.scopes },
      orgId: c.get("orgId"),
    });
  }

  const [user] = await db
    .select({ id: users.id, email: users.email, name: users.name })
    .from(users)
    .where(eq(users.id, actor.id))
    .limit(1);

  const orgs = await listMemberships(actor.id);
  const orgId = c.get("orgId") ?? null;
  const active = orgs.find((o) => o.orgId === orgId) ?? orgs[0];

  return c.json({
    user,
    orgs,
    activeOrgId: active?.orgId ?? null,
    role: active?.role ?? null,
    capabilities: active ? capabilitiesFor(active.role) : [],
  });
});

authRoutes.post("/orgs/switch", requireAuth, async (c) => {
  const actor = c.get("actor");
  if (actor.type !== "user") throw new UserError("API keys are bound to one org");

  const { orgId } = z.object({ orgId: z.number().int() }).parse(await c.req.json());
  const orgs = await listMemberships(actor.id);
  if (!orgs.some((o) => o.orgId === orgId)) {
    // Not a member ⇒ indistinguishable from an org that does not exist.
    throw new UserError("Not found", { status: 404, type: "not-found" });
  }

  await setActiveOrg(actor.sessionId, orgId);
  c.set("orgId", orgId);
  await audit(c, "auth.org_switched", { kind: "org", id: orgId });
  return c.json({ ok: true, orgId });
});

async function uniqueSlug(name: string): Promise<string> {
  const base = slugify(name);
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const candidate = attempt === 0 ? base : `${base}-${attempt + 1}`;
    const clash = await db
      .select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.slug, candidate))
      .limit(1);
    if (clash.length === 0) return candidate;
  }
  return `${base}-${Date.now()}`;
}

export function parseScopes(input: unknown): Capability[] {
  const raw = z.array(z.string()).parse(input);
  const invalid = raw.filter((s) => !isCapability(s));
  if (invalid.length > 0) {
    throw new UserError(`Unknown capability: ${invalid.join(", ")}`);
  }
  return raw.filter(isCapability);
}

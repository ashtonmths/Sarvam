import { auditLog } from "@sadhak/shared/schema";
import type { Context } from "hono";
import { db } from "./db.js";

/**
 * Append-only by construction: this module exports no update or delete path.
 * Every privileged action lands here, because "why did you block my change?"
 * needs an answer with a name on it.
 */

export interface AuditTarget {
  kind: string;
  id: string | number;
}

export async function audit(
  c: Context,
  action: string,
  target?: AuditTarget,
  metadata: Record<string, unknown> = {},
): Promise<void> {
  const actor = c.get("actor");
  const orgId = c.get("orgId") ?? null;

  await db.insert(auditLog).values({
    orgId,
    actorType: actor?.type ?? "system",
    actorId: String(actor?.id ?? "system"),
    action,
    targetKind: target?.kind ?? null,
    targetId: target ? String(target.id) : null,
    ip: clientIp(c),
    userAgent: c.req.header("user-agent") ?? null,
    metadata,
  });
}

/**
 * For a named actor with no Hono context — the MCP tools, which carry their
 * own credential rather than the session middleware's.
 *
 * Separate from `auditSystem` because "system" is a claim, not a fallback: a
 * write an agent performed and an action the scheduler performed must not be
 * indistinguishable in the log that exists to answer who did this. There is no
 * ip or user agent to record, which is a property of the transport rather than
 * something to invent.
 */
export async function auditActor(
  action: string,
  orgId: number,
  actor: { type: string; id: string | number },
  target?: AuditTarget,
  metadata: Record<string, unknown> = {},
): Promise<void> {
  await db.insert(auditLog).values({
    orgId,
    actorType: actor.type,
    actorId: String(actor.id),
    action,
    targetKind: target?.kind ?? null,
    targetId: target ? String(target.id) : null,
    metadata,
  });
}

/** For job handlers and scripts, which have no request context. */
export async function auditSystem(
  action: string,
  orgId: number | null,
  target?: AuditTarget,
  metadata: Record<string, unknown> = {},
): Promise<void> {
  await db.insert(auditLog).values({
    orgId,
    actorType: "system",
    actorId: "system",
    action,
    targetKind: target?.kind ?? null,
    targetId: target ? String(target.id) : null,
    metadata,
  });
}

export function clientIp(c: Context): string | null {
  const forwarded = c.req.header("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0]?.trim() ?? null;
  return c.req.header("x-real-ip") ?? null;
}

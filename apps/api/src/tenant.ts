import { organizations } from "@sadhak/shared/schema";
import { eq } from "drizzle-orm";
import { type Db, db } from "./db.js";
import { NotFoundError } from "./errors.js";

/**
 * The sanctioned path to org data. Route and feature code receives an `OrgDb`
 * — a Drizzle handle plus the org id it is bound to — so the org id a query
 * scopes by always comes from the credential, never from request input.
 *
 * Scoping here is application-level and mandatory by convention. Postgres RLS
 * as defence-in-depth is a production hardening step (plan 3 §3.1) deferred
 * for the hackathon build; the composite FK on `edges` still makes a
 * cross-org edge structurally impossible regardless.
 */
export interface OrgDb {
  readonly db: Db;
  readonly orgId: number;
}

export function orgDb(orgId: number, handle: Db = db): OrgDb {
  return { db: handle, orgId };
}

export async function withOrg<T>(
  orgId: number,
  fn: (scope: OrgDb) => Promise<T>,
  handle: Db = db,
): Promise<T> {
  return fn(orgDb(orgId, handle));
}

export async function getOrgById(orgId: number) {
  const [org] = await db
    .select()
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);
  if (!org) throw new NotFoundError("Organization not found");
  return org;
}

export async function getOrgByPublicId(publicId: string) {
  const [org] = await db
    .select()
    .from(organizations)
    .where(eq(organizations.publicId, publicId))
    .limit(1);
  return org ?? null;
}

export function slugify(input: string): string {
  const base = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return base || "org";
}

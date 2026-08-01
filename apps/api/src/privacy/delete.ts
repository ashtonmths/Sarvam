import { members, organizations } from "@sadhak/shared/schema";
import { and, eq, ne } from "drizzle-orm";
import { db } from "../db.js";
import { NotFoundError, UserError } from "../errors.js";
import { log } from "../log.js";

/**
 * Deleting an organisation, for real.
 *
 * Every table that holds org data declares `onDelete: "cascade"` against
 * `organizations.id`, so this is one statement rather than a hand-maintained
 * teardown list that goes stale the first time someone adds a table. A soft
 * delete would have been easier and would have made the privacy page a lie.
 *
 * There is no undo and no grace period. That is a deliberate reading of "right
 * to erasure": a thirty-day window during which we still hold everything is a
 * retention policy wearing a deletion policy's name. The confirmation
 * requirement below is what stands in for it.
 */

/**
 * The caller must type the org's name back. Not ceremony: this is the one
 * irreversible action in the product, and a misplaced click on a "Delete"
 * button is otherwise indistinguishable from an intent to destroy everything.
 */
export async function deleteOrg(input: {
  orgId: number;
  confirmName: string;
  actor: string;
}): Promise<{ deleted: true; name: string }> {
  const [org] = await db
    .select({ id: organizations.id, name: organizations.name })
    .from(organizations)
    .where(eq(organizations.id, input.orgId))
    .limit(1);

  if (!org) throw new NotFoundError("Organization not found");

  if (input.confirmName !== org.name) {
    throw new UserError(
      `Type the organization name exactly to confirm deletion. Expected "${org.name}".`,
    );
  }

  // Logged before the row disappears, because afterwards there is no org to
  // attribute it to and the audit_log rows cascade away with everything else.
  // This line in the container log is the only surviving trace, which is the
  // honest consequence of deleting an org's audit log along with the org.
  log().warn(
    {
      event: "org_deleted",
      orgId: org.id,
      orgName: org.name,
      actor: input.actor,
    },
    "organization deleted, all data cascaded",
  );

  await db.delete(organizations).where(eq(organizations.id, org.id));

  return { deleted: true, name: org.name };
}

/**
 * Whether this owner is the last one. An org whose only owner leaves cannot be
 * administered by anyone, and the members route needs the same answer, so the
 * question lives here rather than being asked two different ways.
 */
export async function isLastOwner(orgId: number, userId: number): Promise<boolean> {
  const others = await db
    .select({ id: members.id })
    .from(members)
    .where(
      and(
        eq(members.orgId, orgId),
        eq(members.role, "owner"),
        ne(members.userId, userId),
      ),
    )
    .limit(1);

  return others.length === 0;
}

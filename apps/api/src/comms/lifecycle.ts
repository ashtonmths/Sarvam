import {
  edges,
  emailLog,
  members,
  nodes,
  organizations,
  users,
} from "@sadhak/shared/schema";
import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "../db.js";
import { sendMail } from "../email/mailer.js";
import { firstCrawlComplete, firstVerdict } from "../email/templates.js";

/**
 * The two moments that decide whether somebody comes back.
 *
 * Proof of life after connecting, and proof of value at the first verdict.
 * Both are once-ever per org, and the guard is a query against `email_log`
 * rather than a flag on the org — because the log is the record of what was
 * actually sent, and a separate flag is a second source of truth that can
 * disagree with it.
 */

async function alreadySent(orgId: number, template: string): Promise<boolean> {
  const rows = await db
    .select({ id: emailLog.id })
    .from(emailLog)
    .where(and(eq(emailLog.orgId, orgId), eq(emailLog.template, template)))
    .limit(1);
  return rows.length > 0;
}

/** The owner. Lifecycle mail goes to one person, not to everybody. */
async function ownerOf(orgId: number) {
  const [row] = await db
    .select({ id: users.id, email: users.email, orgName: organizations.name })
    .from(members)
    .innerJoin(users, eq(users.id, members.userId))
    .innerJoin(organizations, eq(organizations.id, members.orgId))
    .where(and(eq(members.orgId, orgId), eq(members.role, "owner")))
    .limit(1);
  return row;
}

export async function onFirstCrawlComplete(orgId: number): Promise<void> {
  if (await alreadySent(orgId, "firstCrawlComplete")) return;
  const owner = await ownerOf(orgId);
  if (!owner) return;

  const [nodeCount] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(nodes)
    .where(eq(nodes.orgId, orgId));
  const [edgeCount] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(edges)
    .where(eq(edges.orgId, orgId));

  // An empty first crawl is not a milestone worth an email. It usually means
  // the credential was scoped too narrowly, and "we found nothing, well done"
  // is the wrong first impression.
  if ((nodeCount?.n ?? 0) === 0) return;

  const top = await db
    .select({ name: nodes.name })
    .from(nodes)
    .where(eq(nodes.orgId, orgId))
    .orderBy(desc(nodes.criticality))
    .limit(3);

  const rendered = firstCrawlComplete({
    orgName: owner.orgName,
    nodes: nodeCount?.n ?? 0,
    edges: edgeCount?.n ?? 0,
    topNodes: top.map((n) => n.name),
  });

  await sendMail({
    ...rendered,
    to: owner.email,
    category: "lifecycle",
    template: "firstCrawlComplete",
    userId: owner.id,
    orgId,
  });
}

export async function onFirstVerdict(input: {
  orgId: number;
  verdict: string;
  target: string;
  impacted: string[];
  decisionUrl: string;
}): Promise<void> {
  if (await alreadySent(input.orgId, "firstVerdict")) return;
  const owner = await ownerOf(input.orgId);
  if (!owner) return;

  const rendered = firstVerdict({
    orgName: owner.orgName,
    verdict: input.verdict,
    target: input.target,
    impacted: input.impacted,
    decisionUrl: input.decisionUrl,
  });

  await sendMail({
    ...rendered,
    to: owner.email,
    category: "lifecycle",
    template: "firstVerdict",
    userId: owner.id,
    orgId: input.orgId,
  });
}

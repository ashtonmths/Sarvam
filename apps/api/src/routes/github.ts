import { githubInstallations } from "@sadhak/shared/schema";
import { and, eq, isNull } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { audit } from "../audit.js";
import { db } from "../db.js";
import { NotFoundError } from "../errors.js";
import {
  githubAppConfigured,
  installationToken,
  isCheckRequired,
} from "../github/app.js";
import { requireCapability } from "../middleware/auth.js";

export const githubRoutes = new Hono();

/**
 * Installation status, including the one thing customers get wrong: installing
 * the App but never marking the check required. Without that setting the gate
 * is advisory, and a customer believing they are protected when they are not
 * is worse than no gate at all — so the API says so explicitly.
 */
githubRoutes.get("/github/installations", requireCapability("graph:read"), async (c) => {
  const orgId = c.get("orgId");

  const rows = await db
    .select()
    .from(githubInstallations)
    .where(
      and(eq(githubInstallations.orgId, orgId), isNull(githubInstallations.removedAt)),
    );

  const items = await Promise.all(
    rows.map(async (row) => {
      let enforcing: boolean | null = null;
      if (githubAppConfigured() && row.accountLogin) {
        try {
          const token = await installationToken(row.installationId);
          enforcing = await isCheckRequired(
            token,
            `${row.accountLogin}/${row.accountLogin}`,
          );
        } catch {
          enforcing = null;
        }
      }
      return { ...row, enforcing };
    }),
  );

  return c.json({
    configured: githubAppConfigured(),
    items,
    note: githubAppConfigured()
      ? "An installation with enforcing=false runs the check but does not block merges — require sadhak/gate in branch protection."
      : "The GitHub App is not configured on this deployment.",
  });
});

/**
 * Links an installation to this org. GitHub's installation webhook creates the
 * row before anyone has said which org it belongs to, so claiming it is an
 * explicit, audited act by an admin who can see the installation id.
 */
githubRoutes.post(
  "/github/installations/link",
  requireCapability("connector:manage"),
  async (c) => {
    const orgId = c.get("orgId");
    const body = z
      .object({ installationId: z.number().int().positive() })
      .parse(await c.req.json());

    const updated = await db
      .update(githubInstallations)
      .set({ orgId })
      .where(
        and(
          eq(githubInstallations.installationId, body.installationId),
          isNull(githubInstallations.removedAt),
        ),
      )
      .returning({ id: githubInstallations.id });

    if (updated.length === 0) {
      throw new NotFoundError(
        "No such installation — install the Sadhak app on the repository first, then link it here",
      );
    }

    await audit(c, "github.installation_linked", {
      kind: "github_installation",
      id: body.installationId,
    });
    return c.json({ ok: true, installationId: body.installationId });
  },
);

/** Unlinked installations, so an admin can see what is waiting to be claimed. */
githubRoutes.get(
  "/github/installations/pending",
  requireCapability("connector:manage"),
  async (c) => {
    const rows = await db
      .select({
        installationId: githubInstallations.installationId,
        accountLogin: githubInstallations.accountLogin,
        createdAt: githubInstallations.createdAt,
      })
      .from(githubInstallations)
      .where(
        and(isNull(githubInstallations.orgId), isNull(githubInstallations.removedAt)),
      );
    return c.json({ items: rows });
  },
);

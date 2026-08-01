import { githubInstallations } from "@sadhak/shared/schema";
import { and, eq, isNull } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { audit } from "../audit.js";
import { db } from "../db.js";
import { NotFoundError } from "../errors.js";
import {
  githubAppConfigured,
  installationRepositories,
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
      /**
       * Asked of the repositories the installation actually covers.
       *
       * This used to query `${accountLogin}/${accountLogin}` — the account
       * name in both halves — which is a repository that essentially never
       * exists. GitHub answered 404, `isCheckRequired` reads a 404 as "no
       * protection configured", and so *every* installation rendered the amber
       * "installed, not enforcing" banner, including correctly configured
       * ones. A banner that exists to stop someone believing they are
       * protected was itself the thing lying.
       *
       * Reported per repository, because enforcement is per branch: an org
       * with the check required on one repo and not another is the normal
       * case, and collapsing that to one boolean would replace a false
       * negative with a false positive.
       */
      let enforcing: boolean | null = null;
      let repositories: Array<{ fullName: string; enforcing: boolean | null }> = [];

      if (githubAppConfigured()) {
        try {
          const token = await installationToken(row.installationId);
          const repos = await installationRepositories(token);
          repositories = await Promise.all(
            repos.map(async (repo) => ({
              fullName: repo.fullName,
              enforcing: await isCheckRequired(token, repo.fullName, repo.defaultBranch),
            })),
          );
          /**
           * Only a true claim across every covered repository clears the
           * banner, since one unprotected repo is one place a change can land.
           * An unknown anywhere makes the whole answer unknown rather than
           * false — saying "not enforcing" about a repository we were not
           * permitted to check is the same false alarm this banner exists to
           * prevent, pointed the other way.
           */
          enforcing = repositories.some((r) => r.enforcing === null)
            ? null
            : repositories.length > 0 && repositories.every((r) => r.enforcing === true);
        } catch {
          enforcing = null;
        }
      }
      return { ...row, enforcing, repositories };
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

    /**
     * `orgId IS NULL` is the ownership proof. Without it the predicate matches
     * an installation another org has already claimed, and any admin who can
     * read an installation id could re-point someone else's repositories at
     * their own graph — their verdicts on the victim's merges, the victim's
     * diffs in their UI, and the victim's gate silently dark.
     *
     * Claiming is therefore first-come-once. Re-linking after a genuine
     * transfer means unlinking first, which is an audited act by the org that
     * currently holds it.
     */
    const updated = await db
      .update(githubInstallations)
      .set({ orgId })
      .where(
        and(
          eq(githubInstallations.installationId, body.installationId),
          isNull(githubInstallations.orgId),
          isNull(githubInstallations.removedAt),
        ),
      )
      .returning({ id: githubInstallations.id });

    if (updated.length === 0) {
      throw new NotFoundError(
        "No such unclaimed installation — install the Sadhak app on the repository first, then link it here. An installation already linked to an organisation must be unlinked there before it can be moved.",
      );
    }

    await audit(c, "github.installation_linked", {
      kind: "github_installation",
      id: body.installationId,
    });
    return c.json({ ok: true, installationId: body.installationId });
  },
);

/**
 * There is deliberately no endpoint listing unclaimed installations.
 *
 * An unclaimed row has no org by definition, so such a list cannot be scoped
 * to the caller: it would hand every admin the installation ids and account
 * logins of every other customer mid-onboarding, which is both a disclosure in
 * its own right and exactly the input needed to claim one.
 *
 * An admin links using the installation id GitHub shows them at install time
 * (the trailing number in the settings/installations URL), which they have and
 * strangers do not.
 */

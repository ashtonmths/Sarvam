import { NotImplementedError } from "../../errors.js";
import type {
  Connector,
  ConnectorDescriptor,
  CrawlResult,
  ReadContext,
} from "../types.js";

/**
 * Descriptor and health only. Crawl arrives with Plan 8's hard gate; the
 * scopes are declared complete *now* because a GitHub App permission added
 * later forces every installation through re-approval.
 *
 * "Complete" means every permission any GitHub read in this codebase needs,
 * not only the ones the crawl will need — an installation created from this
 * list must be able to serve `mcp/github.ts` and the CI capture path without a
 * second approval round. Getting that wrong is quiet rather than loud: an
 * ungranted permission returns 403, `perRepo` files it as a note, and a sweep
 * that saw nothing reads exactly like a clean bill of health.
 */

export const descriptor: ConnectorDescriptor = {
  slug: "github",
  displayName: "GitHub",
  auth: "github_app",
  readScopes: [
    { scope: "metadata:read", purpose: "List repositories the App is installed on." },
    {
      scope: "contents:read",
      purpose: "Read files to parse structural references in code.",
    },
    {
      scope: "pull_requests:read",
      purpose: "Read PR metadata to attach a verdict to a change.",
    },
    {
      scope: "checks:read",
      purpose: "Report whether CI is green on a commit, alongside the commit itself.",
    },
    {
      scope: "deployments:read",
      purpose: "Report what reached each environment, and which deployments failed.",
    },
    {
      scope: "actions:read",
      purpose:
        "Read failed workflow runs and the log of the step that failed, to diagnose a broken build.",
    },
  ],
  /**
   * `administration:read` is deliberately absent.
   *
   * It is the only way to read branch protection, which `isCheckRequired` uses
   * to tell a customer whether `sadhak/gate` is actually required rather than
   * merely running. That is one banner, and the permission it costs carries
   * repository settings, collaborators and deploy keys with it — too broad a
   * grant to take for a piece of UI copy. Without it GitHub answers 403,
   * `isCheckRequired` returns null, and the banner says "unknown" instead of
   * guessing. An operator who wants the definite answer can grant it; nothing
   * here requires it.
   */
  writeScopes: [
    {
      scope: "checks:write",
      purpose:
        "Create Sadhak's own Check Run so a BLOCK disables merge. Writes no repository content.",
    },
  ],
  webhooks: true,
  revertible: false,
  crawls: false,
};

export const ALLOWED_PATHS = [/^\/(user|installation)\/repos(\?.*)?$/];

export function authHeaders(secret: { reveal(): string }): Record<string, string> {
  return {
    authorization: `Bearer ${secret.reveal()}`,
    "x-github-api-version": "2022-11-28",
  };
}

export async function crawl(_ctx: ReadContext): Promise<CrawlResult> {
  throw new NotImplementedError("The GitHub crawler lands with Plan 8");
}

export async function health(
  ctx: ReadContext,
): Promise<{ ok: boolean; detail?: string }> {
  try {
    await ctx.http.getJson<unknown>("/installation/repos?per_page=1", ctx.signal);
    return { ok: true, detail: "GitHub API reachable" };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

export const githubConnector: Connector = { descriptor, crawl, health };

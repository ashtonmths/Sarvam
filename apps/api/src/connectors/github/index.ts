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
  ],
  writeScopes: [
    {
      scope: "checks:write",
      purpose:
        "Create Sadhak's own Check Run so a BLOCK disables merge. Writes no repository content.",
    },
  ],
  webhooks: true,
  revertible: false,
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

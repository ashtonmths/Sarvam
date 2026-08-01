import { githubInstallations, organizations } from "@sadhak/shared/schema";
import { and, eq, isNull, sql } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { audit } from "../audit.js";
import {
  type CheckpointKind,
  KIND_CONFIDENCE,
  listCheckpoints,
  recordCheckpoint,
} from "../changes/checkpoints.js";
import { assertReadable } from "../changes/github-client.js";
import {
  DEFAULT_LIMITS,
  investigate,
  renderCandidate,
  summarize,
} from "../changes/investigate.js";
import {
  changesBetween,
  coverageFor,
  findRepository,
  getCursor,
  listRepositories,
  pathsForChanges,
  upsertRepository,
} from "../changes/store.js";
import { db } from "../db.js";
import { NotFoundError, UserError } from "../errors.js";
import { enqueue } from "../jobs/queue.js";
import { requireCapability } from "../middleware/auth.js";

export const changeRoutes = new Hono();

/* ---------------------------------------------------------- repositories */

const repoSchema = z.object({
  /** `owner/name`, the form everyone already copies out of a GitHub URL. */
  fullName: z
    .string()
    .regex(/^[\w.-]+\/[\w.-]+$/, "Use owner/repo, as it appears in the GitHub URL"),
  defaultBranch: z.string().min(1).max(200).optional(),
});

/**
 * Tracks a repository and starts walking its history.
 *
 * Adding it is the act of granting access, the way ticking a Slack channel is,
 * so it takes the same capability.
 */
changeRoutes.post("/repos", requireCapability("connector:manage"), async (c) => {
  const orgId = c.get("orgId");
  const body = repoSchema.parse(await c.req.json());
  const [owner, name] = body.fullName.split("/") as [string, string];

  /**
   * Entitlement first, and the installation carried through.
   *
   * Omitting the installation id here did two things: it fell back to the
   * deployment-wide token for every manually-tracked repository, and — because
   * the upsert writes `installation_id = excluded.installation_id` — it
   * *un-linked* any repository the webhook path had already attached to an
   * installation. So the one caller that never supplied an installation was
   * silently clearing everyone else's.
   */
  const [installationId, singleTenant] = await Promise.all([
    installationForOrg(orgId),
    isSingleTenant(),
  ]);
  await assertReadable({ owner, name, installationId, singleTenant });

  const repoId = await upsertRepository({
    orgId,
    owner,
    name,
    installationId,
    ...(body.defaultBranch ? { defaultBranch: body.defaultBranch } : {}),
  });

  await enqueue(
    "github.backfill",
    { repoId },
    { orgId, dedupeKey: `github.backfill:${repoId}` },
  );
  await audit(c, "repository.tracked", { kind: "repository", id: repoId });

  return c.json(
    {
      id: repoId,
      fullName: `${owner}/${name}`.toLowerCase(),
      note: "History is being walked in the background, newest first. Coverage grows as it runs.",
    },
    201,
  );
});

/** Tracked repositories with how much history has actually landed. */
changeRoutes.get("/repos", requireCapability("graph:read"), async (c) => {
  const orgId = c.get("orgId");
  const repos = await listRepositories(orgId);

  const items = await Promise.all(
    repos.map(async (repo) => {
      const [coverage, commits, pulls] = await Promise.all([
        coverageFor(repo.id),
        getCursor(repo.id, "commit"),
        getCursor(repo.id, "pull_request"),
      ]);
      return {
        id: repo.id,
        fullName: `${repo.owner}/${repo.name}`,
        defaultBranch: repo.defaultBranch,
        linkedToInstallation: repo.installationId !== null,
        changes: coverage.changes,
        earliest: coverage.earliest,
        latest: coverage.latest,
        // Stated rather than implied: a half-walked repository must not look
        // like one whose history simply starts there.
        backfillComplete: commits.complete && pulls.complete,
      };
    }),
  );

  return c.json({ items });
});

/* ------------------------------------------------------------ checkpoints */

const checkpointSchema = z.object({
  label: z.string().min(1).max(300),
  kind: z
    .enum(["manual", "gate_approved", "crawl_healthy", "incident_recovered", "release"])
    .default("manual"),
  occurredAt: z.string().datetime({ offset: true }).optional(),
  repoFullName: z.string().optional(),
  environment: z.string().max(100).optional(),
  sourceUrl: z.string().url().optional(),
  confidence: z.number().min(0).max(1).optional(),
});

/**
 * Marks a moment as known-good.
 *
 * `graph:read` rather than a manage capability: saying "this looked fine at
 * 14:00" is an observation anyone on the team can make, and a checkpoint only
 * ever narrows a search — a wrong one costs a wasted round, never a wrong
 * verdict.
 */
changeRoutes.post("/checkpoints", requireCapability("graph:read"), async (c) => {
  const orgId = c.get("orgId");
  const body = checkpointSchema.parse(await c.req.json());

  let repoId: number | null = null;
  if (body.repoFullName) {
    const [owner, name] = body.repoFullName.split("/");
    if (!owner || !name) throw new UserError("Use owner/repo", { status: 422 });
    const repo = await findRepository(orgId, owner, name);
    if (!repo) throw new NotFoundError(`${body.repoFullName} is not tracked yet`);
    repoId = repo.id;
  }

  const occurredAt = body.occurredAt ? new Date(body.occurredAt) : new Date();
  if (occurredAt.getTime() > Date.now() + 60_000) {
    throw new UserError("A checkpoint cannot be in the future", { status: 422 });
  }

  const id = await recordCheckpoint({
    orgId,
    kind: body.kind as CheckpointKind,
    label: body.label,
    occurredAt,
    repoId,
    environment: body.environment ?? null,
    sourceUrl: body.sourceUrl ?? null,
    ...(body.confidence === undefined ? {} : { confidence: body.confidence }),
    createdBy: actorLabel(c.get("actor")),
  });

  await audit(c, "checkpoint.recorded", { kind: "checkpoint", id });
  // The stored value, not the kind's default — answering 0.95 to a request
  // that supplied 0.2 describes a row that does not exist.
  return c.json(
    { id, occurredAt, confidence: body.confidence ?? KIND_CONFIDENCE[body.kind] },
    201,
  );
});

changeRoutes.get("/checkpoints", requireCapability("graph:read"), async (c) => {
  const orgId = c.get("orgId");
  return c.json({ items: await listCheckpoints(orgId) });
});

/* ---------------------------------------------------------- investigation */

const investigateSchema = z.object({
  /** What broke, in words. The failing table, service, or error text. */
  symptom: z.string().min(2).max(500),
  incidentAt: z.string().datetime({ offset: true }).optional(),
  repoFullName: z.string().optional(),
  pathHints: z.array(z.string().max(300)).max(20).optional(),
  maxWindows: z.number().int().min(1).max(8).optional(),
});

/**
 * The expanding-window search.
 *
 * Synchronous because it is arithmetic over indexed rows, not an agent loop —
 * a handful of range scans and a ranking pass. There is no model in this path,
 * which is what lets it answer in milliseconds and be identical every time it
 * is asked.
 */
changeRoutes.post("/investigate", requireCapability("graph:read"), async (c) => {
  const orgId = c.get("orgId");
  const body = investigateSchema.parse(await c.req.json());

  let repoIds: number[] | undefined;
  if (body.repoFullName) {
    const [owner, name] = body.repoFullName.split("/");
    if (!owner || !name) throw new UserError("Use owner/repo", { status: 422 });
    const repo = await findRepository(orgId, owner, name);
    if (!repo) throw new NotFoundError(`${body.repoFullName} is not tracked yet`);
    repoIds = [repo.id];
  }

  const incidentAt = body.incidentAt ? new Date(body.incidentAt) : new Date();

  const investigation = await investigate(
    orgId,
    incidentAt,
    {
      /**
       * Split on anything that is not a word character. A dotted name like
       * `invoices.vat_rate` becomes both halves, which is what matches a file
       * path — keeping the dot produced one token that only matched a literal
       * dotted substring, the form least likely to appear anywhere. The ranker
       * then drops stopwords and anything too short to discriminate.
       */
      terms: body.symptom.split(/\W+/).filter(Boolean),
      ...(repoIds ? { repoIds } : {}),
      ...(body.pathHints ? { pathHints: body.pathHints } : {}),
    },
    { ...DEFAULT_LIMITS, ...(body.maxWindows ? { maxWindows: body.maxWindows } : {}) },
  );

  // `summarize` already renders its own candidates, and the rounds go through
  // the same function — one shape for a candidate, everywhere on the response.
  return c.json({
    ...summarize(investigation),
    stoppedBecause: investigation.stoppedBecause,
    rounds: investigation.rounds.map((round) => ({
      reason: round.window.reason,
      from: round.window.from,
      to: round.window.to,
      totalInWindow: round.totalInWindow,
      // Carried through, so a partial round is visible per-round and not only
      // in the top-level caveat.
      truncated: round.truncated,
      confidence: round.confidence,
      top: round.candidates.slice(0, 3).map(renderCandidate),
    })),
  });
});

/** Raw changes in a window, for the timeline view. */
const windowQuerySchema = z.object({
  from: z.string().datetime({ offset: true }),
  to: z.string().datetime({ offset: true }),
});

changeRoutes.get("/changes", requireCapability("graph:read"), async (c) => {
  const orgId = c.get("orgId");
  // Parsed like every request body in this file. Unvalidated, `?from=banana`
  // reached drizzle as an Invalid Date and surfaced as a 500 rather than a 422.
  const window = windowQuerySchema.parse({
    from: c.req.query("from"),
    to: c.req.query("to"),
  });

  const rows = await changesBetween(
    orgId,
    { from: new Date(window.from), to: new Date(window.to) },
    200,
  );
  const paths = await pathsForChanges(rows.map((r) => r.id));

  return c.json({
    items: rows.map((change) => ({ ...change, paths: paths.get(change.id) ?? [] })),
  });
});

function actorLabel(actor: { type: string; id: number } | undefined): string {
  if (!actor) return "unknown";
  return actor.type === "api_key" ? `api_key:${actor.id}` : `user:${actor.id}`;
}

/** The org's live GitHub App installation, if it has claimed one. */
async function installationForOrg(orgId: number): Promise<number | null> {
  const [row] = await db
    .select({ installationId: githubInstallations.installationId })
    .from(githubInstallations)
    .where(
      and(eq(githubInstallations.orgId, orgId), isNull(githubInstallations.removedAt)),
    )
    .limit(1);
  return row?.installationId ?? null;
}

/**
 * Whether this deployment serves exactly one organisation.
 *
 * Counted rather than configured, so it cannot drift: the moment a second org
 * is created the shared-token shortcut stops being available, without anyone
 * remembering to change a setting.
 */
async function isSingleTenant(): Promise<boolean> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(organizations);
  return (row?.count ?? 0) <= 1;
}

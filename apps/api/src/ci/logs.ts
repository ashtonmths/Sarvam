import { tokenForRepo } from "../changes/github-client.js";

/**
 * Turning an Actions run into the few lines that explain why it failed.
 *
 * The logs endpoint returns a zip of every job's full output, which for this
 * repository's own CI is megabytes of pnpm resolution and Docker layer pulls.
 * None of it is the answer. What a person actually does is open the red job,
 * scroll to the red step, and read the last screen — so that is what this does,
 * and it does it through the jobs API rather than by unzipping, because that
 * API already names the failing step and gives its line range.
 */

const GITHUB_API = "https://api.github.com";

export interface FailingStep {
  jobName: string;
  stepName: string | null;
  /** The tail of that job's log: the error and what led to it. */
  excerpt: string;
}

interface JobStep {
  name: string;
  conclusion: string | null;
  number: number;
}

interface Job {
  id: number;
  name: string;
  conclusion: string | null;
  steps?: JobStep[];
}

/** Lines kept from the end of a failing job's log. */
const TAIL_LINES = 120;
/** Hard ceiling, so one pathological line cannot blow the model's context. */
const MAX_CHARS = 8000;

async function gh(url: string, token: string): Promise<Response> {
  return fetch(url, {
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
    },
  });
}

/**
 * Strips the timestamp each Actions log line is prefixed with, and the ANSI
 * colour codes around it. Both are noise to a reader and, worse, they are
 * noise that differs on every run — leaving them in would make two identical
 * failures compare as different in `signatureOf`.
 */
function clean(line: string): string {
  return (
    line
      // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escapes are control characters by definition.
      .replace(/\[[0-9;]*m/g, "")
      .replace(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z\s?/, "")
      .trimEnd()
  );
}

/**
 * Finds the failed job, reads its log, and returns the tail.
 *
 * Returns null rather than throwing when GitHub will not give up the logs.
 * Log retention expires, and a run analysed a fortnight later is a normal
 * thing to ask for — the caller still has the run's metadata and can say what
 * failed even when it cannot say why.
 */
export async function failingStepOf(
  owner: string,
  name: string,
  runId: number,
  installationId: number | null,
): Promise<FailingStep | null> {
  // Throws when no credential can read the repo, which is a configuration
  // answer rather than an analysis one — the caller records it and moves on
  // instead of letting one unreadable repo fail the job.
  let token: string;
  try {
    // Only these three fields are read. The wider Repository row is the
    // caller's concern, not this function's.
    token = await tokenForRepo({ owner, name, installationId } as Parameters<
      typeof tokenForRepo
    >[0]);
  } catch {
    return null;
  }

  const jobsRes = await gh(
    `${GITHUB_API}/repos/${owner}/${name}/actions/runs/${runId}/jobs?per_page=100`,
    token,
  );
  if (!jobsRes.ok) return null;

  const { jobs = [] } = (await jobsRes.json()) as { jobs?: Job[] };
  const failed = jobs.find((job) => job.conclusion === "failure");
  if (!failed) return null;

  // The step is reported separately from the log, and it is the more reliable
  // of the two: the log tail can be a stack trace with no indication of which
  // step produced it.
  const step = failed.steps?.find((s) => s.conclusion === "failure") ?? null;

  const logRes = await gh(
    `${GITHUB_API}/repos/${owner}/${name}/actions/jobs/${failed.id}/logs`,
    token,
  );
  if (!logRes.ok) {
    return { jobName: failed.name, stepName: step?.name ?? null, excerpt: "" };
  }

  const body = await logRes.text();
  const lines = body.split("\n").map(clean).filter(Boolean);
  let excerpt = lines.slice(-TAIL_LINES).join("\n");
  if (excerpt.length > MAX_CHARS) excerpt = excerpt.slice(-MAX_CHARS);

  return { jobName: failed.name, stepName: step?.name ?? null, excerpt };
}

/**
 * A comparable fingerprint for "the same failure".
 *
 * Two runs of one broken test produce logs that share no exact line: paths
 * carry a runner id, durations differ, hashes differ, line numbers shift as the
 * file is edited. Matching on raw text finds nothing and the precedent search
 * silently returns empty, which looks the same as a novel failure.
 *
 * So the variable parts are replaced with placeholders and only the last few
 * lines are kept — the error itself, not the traceback that led to it, since
 * the traceback is the part that moves when code around it changes.
 */
export function signatureOf(excerpt: string): string {
  const normalised = excerpt
    .split("\n")
    .slice(-12)
    .map((line) =>
      line
        // Timestamps first, and anchored rather than left to the generic
        // number rule below. `clean` already strips them off a live fetch, but
        // this also runs against excerpts read back out of the database, and an
        // unstripped ISO timestamp differs on every run — which would make two
        // identical failures produce different signatures and find no
        // precedent, silently.
        .replace(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z?\s*/, "")
        .replace(/\b[0-9a-f]{7,40}\b/gi, "<sha>")
        .replace(/\b\d+(\.\d+)?(ms|s|m)\b/g, "<dur>")
        .replace(/:\d+:\d+/g, ":<pos>")
        .replace(/\/(home|Users|tmp|runner)\/\S+/g, "<path>")
        .replace(/\b\d{4}-\d{2}-\d{2}\b/g, "<date>")
        .replace(/\b\d+\b/g, "<n>")
        .trim(),
    )
    .filter((line) => line.length > 0)
    .join(" | ");

  return normalised.slice(0, 1000);
}

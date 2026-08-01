import { connectorInstances } from "@sadhak/shared/schema";
import { and, eq } from "drizzle-orm";
import { db } from "../../db.js";
import {
  type ChangedFile,
  getFileContent,
  listChangedFiles,
  MAX_CHANGED_FILES,
} from "../../github/app.js";
import { extractFromN8n, isN8nWorkflowFile } from "./n8n.js";
import { extractFromSql, type SqlExtractContext } from "./sql.js";
import { type ExtractionResult, emptyExtraction, mergeExtractions } from "./types.js";

/**
 * Turns a pull request into change descriptors, conservatively.
 *
 * Anything not confidently understood becomes an `unknowns` entry, which
 * renders the check `neutral` — never a failure. A missed catch costs a save;
 * a false BLOCK costs the account.
 */

/**
 * The org's Postgres instance, or an honest refusal. Cartographer writes
 * Postgres nodes under instance-qualified ids because pg names are not
 * globally unique, so a diff's bare `invoices` cannot be resolved without
 * knowing which connected database it means.
 */
export async function resolveSqlContext(orgId: number): Promise<SqlExtractContext> {
  const instances = await db
    .select({ id: connectorInstances.id, config: connectorInstances.config })
    .from(connectorInstances)
    .where(
      and(
        eq(connectorInstances.orgId, orgId),
        eq(connectorInstances.connector, "postgres"),
      ),
    );

  if (instances.length !== 1) {
    return { instanceId: null, database: null, candidateInstances: instances.length };
  }

  const instance = instances[0];
  if (!instance) {
    return { instanceId: null, database: null, candidateInstances: 0 };
  }

  // The crawler writes `{instanceId}/db/{database}/...`, so the database name
  // is recoverable from the ids it already wrote.
  const database = await databaseNameFor(orgId, instance.id);
  if (!database) {
    return { instanceId: null, database: null, candidateInstances: 1 };
  }

  return { instanceId: instance.id, database, candidateInstances: 1 };
}

async function databaseNameFor(
  orgId: number,
  instanceId: number,
): Promise<string | null> {
  const rows = await db.execute<{ external_id: string }>(
    // biome-ignore lint/style/noUnusedTemplateLiteral: drizzle raw fragment
    `SELECT external_id FROM nodes
     WHERE org_id = ${orgId} AND connector = 'postgres'
       AND connector_instance_id = ${instanceId}
     LIMIT 1` as never,
  );
  const first = (rows as unknown as Array<{ external_id: string }>)[0];
  if (!first) return null;
  const match = /\/db\/([^/]+)\//.exec(first.external_id);
  return match?.[1] ?? null;
}

export interface ExtractInput {
  orgId: number;
  token: string;
  repo: string;
  prNumber: number;
  baseSha: string;
  headSha: string;
  /** Where the org keeps exported n8n workflows, if it does. */
  n8nWorkflowPath?: string | null;
}

export async function extractFromPullRequest(
  input: ExtractInput,
): Promise<ExtractionResult> {
  const { files, truncated } = await listChangedFiles(
    input.token,
    input.repo,
    input.prNumber,
  );
  const results: ExtractionResult[] = [];

  if (truncated) {
    const overflow = emptyExtraction();
    overflow.unknowns.push({
      file: "(pull request)",
      reason: `more than ${MAX_CHANGED_FILES} files changed — the remainder was not read`,
    });
    results.push(overflow);
  }

  const sqlContext = await resolveSqlContext(input.orgId);

  for (const file of files) {
    results.push(await extractFile(input, file, sqlContext));
  }

  return mergeExtractions(...results);
}

async function extractFile(
  input: ExtractInput,
  file: ChangedFile,
  sqlContext: SqlExtractContext,
): Promise<ExtractionResult> {
  const result = emptyExtraction();

  if (file.filename.endsWith(".sql")) {
    // A deleted migration file is not a schema change; only its contents at
    // the head ref describe what the PR proposes to do.
    if (file.status === "removed") return result;

    const contents = await getFileContent(
      input.token,
      input.repo,
      file.filename,
      input.headSha,
    );
    if (contents === null) {
      result.unknowns.push({ file: file.filename, reason: "file contents unreadable" });
      return result;
    }
    return extractFromSql(file.filename, contents, sqlContext);
  }

  if (isN8nWorkflowFile(file.filename, input.n8nWorkflowPath ?? null)) {
    const [before, after] = await Promise.all([
      getFileContent(input.token, input.repo, file.filename, input.baseSha),
      file.status === "removed"
        ? Promise.resolve(null)
        : getFileContent(input.token, input.repo, file.filename, input.headSha),
    ]);
    return extractFromN8n(file.filename, before, after);
  }

  // Everything else is genuinely irrelevant — a README change is not an
  // unknown, and flagging it would fill the check summary with noise.
  return result;
}

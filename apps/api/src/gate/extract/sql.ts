import type { ChangeDescriptor } from "@sadhak/shared/types";
import { type ExtractionResult, emptyExtraction } from "./types.js";

/**
 * SQL migration DDL → change descriptors.
 *
 * Deliberately narrow. Three statement shapes are recognized, and *everything*
 * else — including table-level changes that have no representable descriptor —
 * goes to `unknowns`. Adding a `table` variant is a shared-contract change, not
 * something to improvise here.
 *
 * A hand-rolled recognizer rather than a full parser: the grammar we accept is
 * three regexes wide, and a parser that understands more SQL would tempt us
 * into interpreting more than we can justify blocking on.
 */

export interface SqlExtractContext {
  /** The org's Postgres connector instance. Zero or many ⇒ we refuse to guess. */
  instanceId: number | null;
  database: string | null;
  /** How many Postgres instances the org has connected. */
  candidateInstances: number;
}

const DROP_COLUMN =
  /alter\s+table\s+(?:if\s+exists\s+)?([\w".]+)\s+drop\s+(?:column\s+)?(?:if\s+exists\s+)?([\w"]+)/i;
const RENAME_COLUMN =
  /alter\s+table\s+(?:if\s+exists\s+)?([\w".]+)\s+rename\s+(?:column\s+)?([\w"]+)\s+to\s+([\w"]+)/i;
const ALTER_TYPE =
  /alter\s+table\s+(?:if\s+exists\s+)?([\w".]+)\s+alter\s+(?:column\s+)?([\w"]+)\s+(?:set\s+data\s+)?type\s+([\w\s().,]+)/i;

/** Table-level changes have no representable descriptor in the union. */
const TABLE_LEVEL =
  /^\s*(drop\s+table|drop\s+view|alter\s+table\s+[\w".]+\s+rename\s+to)/i;

function unquote(identifier: string): string {
  return identifier.replace(/"/g, "").trim();
}

function splitQualified(raw: string): { schema: string; table: string } {
  const parts = unquote(raw).split(".");
  if (parts.length >= 2) {
    return {
      schema: parts[parts.length - 2] ?? "public",
      table: parts[parts.length - 1] ?? "",
    };
  }
  return { schema: "public", table: parts[0] ?? "" };
}

/**
 * Splits on semicolons outside string literals and comments. Enough for
 * migration files; anything it mangles ends up as an unparsed statement, which
 * is the safe direction.
 */
export function splitStatements(sql: string): string[] {
  const withoutComments = sql.replace(/--[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");

  const statements: string[] = [];
  let current = "";
  let inString = false;

  for (const char of withoutComments) {
    if (char === "'") inString = !inString;
    if (char === ";" && !inString) {
      if (current.trim()) statements.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }
  if (current.trim()) statements.push(current.trim());
  return statements;
}

export function extractFromSql(
  file: string,
  contents: string,
  ctx: SqlExtractContext,
): ExtractionResult {
  const result = emptyExtraction();

  for (const statement of splitStatements(contents)) {
    if (!/^\s*alter\s+table|^\s*drop\s+(table|view)/i.test(statement)) {
      // Not DDL we model at all — a CREATE INDEX or an INSERT is not a change
      // to the dependency graph, so it is silently irrelevant rather than an
      // unknown. Only statements we *should* have understood become unknowns.
      continue;
    }

    if (TABLE_LEVEL.test(statement)) {
      result.unknowns.push({
        file,
        reason: "table-level change: not yet modelled",
      });
      continue;
    }

    const matched =
      matchDropColumn(statement) ??
      matchRenameColumn(statement) ??
      matchAlterType(statement);

    if (!matched) {
      result.unknowns.push({
        file,
        reason: `unrecognized DDL: ${statement.slice(0, 120)}`,
      });
      continue;
    }

    // externalId construction is a resolution step, not string formatting:
    // Postgres names are not globally unique, so an id needs the instance and
    // database Cartographer wrote under. Guessing which instance a migration
    // targets is exactly the over-eager interpretation that produces a false
    // BLOCK.
    if (ctx.instanceId === null || ctx.database === null) {
      result.unknowns.push({
        file,
        reason:
          ctx.candidateInstances === 0
            ? "cannot attribute migration to a connected database"
            : `migration matches ${ctx.candidateInstances} connected databases — cannot attribute`,
      });
      continue;
    }

    const externalId = `${ctx.instanceId}/db/${ctx.database}/column/${matched.schema}.${matched.table}.${matched.column}`;
    const change: ChangeDescriptor = {
      target: "field",
      connector: "postgres",
      operation: matched.operation,
      externalId,
      ...(matched.newName ? { newName: matched.newName } : {}),
      ...(matched.newType ? { newType: matched.newType } : {}),
    };
    result.changes.push(change);
  }

  return result;
}

interface Matched {
  schema: string;
  table: string;
  column: string;
  operation: "delete" | "rename" | "retype";
  newName?: string;
  newType?: string;
}

function matchDropColumn(statement: string): Matched | null {
  const m = DROP_COLUMN.exec(statement);
  if (!m?.[1] || !m[2]) return null;
  const { schema, table } = splitQualified(m[1]);
  return { schema, table, column: unquote(m[2]), operation: "delete" };
}

function matchRenameColumn(statement: string): Matched | null {
  const m = RENAME_COLUMN.exec(statement);
  if (!m?.[1] || !m[2] || !m[3]) return null;
  const { schema, table } = splitQualified(m[1]);
  return {
    schema,
    table,
    column: unquote(m[2]),
    operation: "rename",
    newName: unquote(m[3]),
  };
}

function matchAlterType(statement: string): Matched | null {
  const m = ALTER_TYPE.exec(statement);
  if (!m?.[1] || !m[2] || !m[3]) return null;
  const { schema, table } = splitQualified(m[1]);
  return {
    schema,
    table,
    column: unquote(m[2]),
    operation: "retype",
    newType: m[3].trim().replace(/\s+/g, " "),
  };
}

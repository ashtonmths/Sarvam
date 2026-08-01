import postgres from "postgres";
import { UpstreamError } from "../../errors.js";
import type {
  Connector,
  ConnectorDescriptor,
  CrawlResult,
  EdgeSpec,
  NodeSpec,
  ReadContext,
} from "../types.js";

/**
 * Catalog-only crawler. Every query in this module touches `information_schema`
 * or `pg_catalog` and nothing else — a unit test regex-scans the SQL strings to
 * keep it that way — and the session is hardened read-only on connect, so a
 * write is a database error rather than a code-review catch.
 */

export const descriptor: ConnectorDescriptor = {
  slug: "postgres",
  displayName: "PostgreSQL",
  auth: "connection_string",
  readScopes: [
    {
      scope: "CONNECT + USAGE ON SCHEMA (role sadhak_ro)",
      purpose: "Reach the database to read its catalog. No table SELECT is requested.",
    },
    {
      scope: "SELECT ON information_schema, pg_catalog",
      purpose: "Read table, column, foreign-key and view-dependency structure.",
    },
  ],
  writeScopes: [],
  webhooks: false,
  revertible: false,
};

/** The exact grant published in docs/connectors/postgres.md. */
export const SETUP_GRANT = `CREATE ROLE sadhak_ro LOGIN PASSWORD '…' NOSUPERUSER NOCREATEDB;
GRANT CONNECT ON DATABASE app TO sadhak_ro;
GRANT USAGE ON SCHEMA public TO sadhak_ro;`;

const SKIP_SCHEMAS = ["pg_catalog", "information_schema", "pg_toast"];

async function connect(connectionString: string, signal?: AbortSignal) {
  const sql = postgres(connectionString, {
    max: 1,
    idle_timeout: 10,
    connect_timeout: 10,
    connection: { application_name: "sadhak-crawler" },
    onnotice: () => {},
  });
  signal?.addEventListener("abort", () => void sql.end({ timeout: 1 }), { once: true });

  // Session hardening: even a bug cannot write through this connection.
  await sql`SET default_transaction_read_only = on`;
  await sql`SET statement_timeout = '15s'`;
  return sql;
}

export async function crawl(ctx: ReadContext): Promise<CrawlResult> {
  const sql = await connect(ctx.secret.reveal(), ctx.signal);
  const nodes: NodeSpec[] = [];
  const edges: EdgeSpec[] = [];
  const prefix = String(ctx.instance.id);

  try {
    const [dbRow] = await sql<
      { database: string }[]
    >`SELECT current_database() AS database`;
    const database = dbRow?.database ?? "postgres";

    const tableKey = (schema: string, name: string) => ({
      connector: "postgres",
      externalId: `${prefix}/db/${database}/table/${schema}.${name}`,
    });
    const viewKey = (schema: string, name: string) => ({
      connector: "postgres",
      externalId: `${prefix}/db/${database}/view/${schema}.${name}`,
    });
    const columnKey = (schema: string, table: string, column: string) => ({
      connector: "postgres",
      externalId: `${prefix}/db/${database}/column/${schema}.${table}.${column}`,
    });

    const relations = await sql<
      { table_schema: string; table_name: string; table_type: string }[]
    >`
      SELECT table_schema, table_name, table_type
      FROM information_schema.tables
      WHERE table_schema NOT IN ${sql(SKIP_SCHEMAS)}
    `;

    const isView = new Map<string, boolean>();
    for (const rel of relations) {
      const view = rel.table_type === "VIEW";
      isView.set(`${rel.table_schema}.${rel.table_name}`, view);
      nodes.push({
        key: view
          ? viewKey(rel.table_schema, rel.table_name)
          : tableKey(rel.table_schema, rel.table_name),
        kind: view ? "report" : "table",
        name: `${rel.table_schema}.${rel.table_name}`,
        metadata: { database, schema: rel.table_schema, relationKind: rel.table_type },
      });
    }

    const columns = await sql<
      {
        table_schema: string;
        table_name: string;
        column_name: string;
        data_type: string;
        is_nullable: string;
      }[]
    >`
      SELECT table_schema, table_name, column_name, data_type, is_nullable
      FROM information_schema.columns
      WHERE table_schema NOT IN ${sql(SKIP_SCHEMAS)}
    `;

    for (const col of columns) {
      const parentIsView = isView.get(`${col.table_schema}.${col.table_name}`) ?? false;
      if (parentIsView) continue; // view columns are not independent structure

      const field = columnKey(col.table_schema, col.table_name, col.column_name);
      nodes.push({
        key: field,
        kind: "field",
        name: `${col.table_name}.${col.column_name}`,
        metadata: {
          columnType: col.data_type,
          isNullable: col.is_nullable === "YES",
          schema: col.table_schema,
        },
      });
      edges.push({
        src: field,
        dst: tableKey(col.table_schema, col.table_name),
        kind: "DERIVES_FROM",
        provenance: "static_parse",
      });
    }

    // A foreign key means the referencing table depends on the referenced one.
    const fks = await sql<
      {
        src_schema: string;
        src_table: string;
        dst_schema: string;
        dst_table: string;
      }[]
    >`
      SELECT tc.table_schema      AS src_schema,
             tc.table_name        AS src_table,
             ccu.table_schema     AS dst_schema,
             ccu.table_name       AS dst_table
      FROM information_schema.table_constraints tc
      JOIN information_schema.constraint_column_usage ccu
        ON ccu.constraint_name = tc.constraint_name
       AND ccu.constraint_schema = tc.constraint_schema
      WHERE tc.constraint_type = 'FOREIGN KEY'
        AND tc.table_schema NOT IN ${sql(SKIP_SCHEMAS)}
    `;

    for (const fk of fks) {
      edges.push({
        src: tableKey(fk.src_schema, fk.src_table),
        dst: tableKey(fk.dst_schema, fk.dst_table),
        kind: "READS_FROM",
        provenance: "static_parse",
      });
    }

    // View dependencies via pg_depend/pg_rewrite, not view_column_usage, which
    // under-reports across ownership boundaries. This is the edge that makes
    // eu_vat_report -> invoices.vat_rate real instead of seeded.
    const viewDeps = await sql<
      {
        view_schema: string;
        view_name: string;
        table_schema: string;
        table_name: string;
        column_name: string;
      }[]
    >`
      SELECT vn.nspname AS view_schema,
             v.relname  AS view_name,
             tn.nspname AS table_schema,
             t.relname  AS table_name,
             a.attname  AS column_name
      FROM pg_depend d
      JOIN pg_rewrite r    ON r.oid = d.objid
      JOIN pg_class v      ON v.oid = r.ev_class
      JOIN pg_namespace vn ON vn.oid = v.relnamespace
      JOIN pg_class t      ON t.oid = d.refobjid
      JOIN pg_namespace tn ON tn.oid = t.relnamespace
      JOIN pg_attribute a  ON a.attrelid = d.refobjid AND a.attnum = d.refobjsubid
      WHERE d.classid = 'pg_rewrite'::regclass
        AND d.refclassid = 'pg_class'::regclass
        AND d.deptype = 'n'
        AND v.oid <> t.oid
        AND d.refobjsubid > 0
        AND tn.nspname NOT IN ${sql(SKIP_SCHEMAS)}
    `;

    for (const dep of viewDeps) {
      edges.push({
        src: viewKey(dep.view_schema, dep.view_name),
        dst: columnKey(dep.table_schema, dep.table_name, dep.column_name),
        kind: "DERIVES_FROM",
        provenance: "static_parse",
      });
    }

    return { nodes, edges };
  } catch (error) {
    throw new UpstreamError(
      `postgres crawl failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    await sql.end({ timeout: 5 });
  }
}

export async function health(
  ctx: ReadContext,
): Promise<{ ok: boolean; detail?: string }> {
  let sql: postgres.Sql | null = null;
  try {
    sql = await connect(ctx.secret.reveal(), ctx.signal);
    const [row] = await sql<{ current_user: string; version: string }[]>`
      SELECT current_user, version()
    `;
    return { ok: true, detail: `connected as ${row?.current_user ?? "unknown"}` };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  } finally {
    await sql?.end({ timeout: 3 });
  }
}

export const postgresConnector: Connector = { descriptor, crawl, health };

import * as schema from "@ariadne/shared/schema";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is not set");

// max: 10 leaves headroom for the job workers running alongside the API.
export const sql = postgres(url, { max: 10 });
export const db = drizzle(sql, { schema });

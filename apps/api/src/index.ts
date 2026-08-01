import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { sql } from "./db.js";

const app = new Hono();

app.get("/health", async (c) => {
  try {
    await sql`SELECT 1`;
    return c.json({ ok: true, db: "up" });
  } catch {
    return c.json({ ok: false, db: "down" }, 503);
  }
});

const port = Number(process.env.PORT ?? 3001);
serve({ fetch: app.fetch, port }, (info) => {
  console.log(`ariadne api listening on :${info.port}`);
});

export { app };

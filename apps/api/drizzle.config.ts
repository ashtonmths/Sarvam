import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "../../packages/shared/src/schema.ts",
  out: "../../db/migrations",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgres://sadhak:sadhak@localhost:5432/sadhak",
  },
});

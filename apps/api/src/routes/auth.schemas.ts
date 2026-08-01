import { z } from "zod";

/**
 * The auth request shapes, in a module that imports nothing but zod.
 *
 * They live here rather than in `auth.ts` so the OpenAPI generator can read
 * them without pulling in the handlers — and through them the database client
 * and the env schema. Importing the route module to reach its schemas meant
 * rendering a document that describes the API's shape required a
 * `DATABASE_URL`, which failed in CI and passed locally only because a `.env`
 * file happens to sit on disk.
 *
 * The single-source property is unchanged and is the whole point: `auth.ts`
 * validates with these exact objects, so the spec cannot describe a shape the
 * handler does not accept.
 */

export const signupSchema = z.object({
  name: z.string().min(1).max(120),
  email: z.string().email().max(254),
  password: z.string(),
  company: z.string().max(120).optional(),
});

export const signinSchema = z.object({
  email: z.string().email().max(254),
  password: z.string(),
});

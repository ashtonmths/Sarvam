import { embeddingState } from "@sadhak/shared/schema";
import { eq } from "drizzle-orm";
import { db, sql as raw } from "./db.js";
import { activeEmbeddingModel } from "./embed.js";
import { log } from "./log.js";

/**
 * Makes changing the embedding provider a safe operation.
 *
 * Two embedding models do not share a vector space, even when they agree on
 * width — bge-small and MiniLM both emit 384 numbers and those numbers mean
 * different things. Compare a query embedded by one against chunks embedded by
 * the other and cosine distance is noise.
 *
 * The reason this needs code rather than a note in a runbook is that nothing
 * fails when it happens. No error, no exception, no failed insert: hybrid
 * retrieval still returns rows because the lexical half is unaffected, and the
 * semantic half quietly contributes garbage. The symptom is "search got a bit
 * worse", which nobody files a bug about.
 *
 * So the model that produced the vectors is recorded next to them, and a change
 * clears the column. The embed job already sweeps for NULL vectors and refills
 * them, so recovery is automatic — it costs one repass over the corpus, which
 * is the correct price for changing what the numbers mean.
 */
export async function reconcileEmbeddingModel(): Promise<void> {
  const current = activeEmbeddingModel();

  const [row] = await db.select().from(embeddingState).limit(1);

  if (!row) {
    // First boot, or an upgrade from before this table existed. Adopt the
    // current model without clearing: whatever is stored was produced by
    // bge-small, which is what `local` still means.
    await db.insert(embeddingState).values({ id: 1, model: current });
    log().info(
      { event: "embedding_model_adopted", model: current },
      "embeddings: model recorded",
    );
    return;
  }

  if (row.model === current) return;

  /**
   * Cleared in one statement per table rather than per row. This is rare — a
   * deliberate config change — and doing it as a bulk UPDATE keeps the window
   * where two vector spaces coexist as short as the database can make it.
   */
  const chunks =
    await raw`UPDATE document_chunks SET embedding = NULL WHERE embedding IS NOT NULL`;
  const rationale =
    await raw`UPDATE rationale SET embedding = NULL WHERE embedding IS NOT NULL`;

  await db
    .update(embeddingState)
    .set({ model: current, updatedAt: new Date() })
    .where(eq(embeddingState.id, 1));

  log().warn(
    {
      event: "embedding_model_changed",
      from: row.model,
      to: current,
      clearedChunks: chunks.count ?? 0,
      clearedRationale: rationale.count ?? 0,
    },
    "embeddings: model changed, vectors cleared for recompute",
  );
}

import { existsSync } from "node:fs";
import { env, type FeatureExtractionPipeline, pipeline } from "@huggingface/transformers";
import { config, requireEnv } from "./config.js";
import { embeddingDuration, embeddingWindows } from "./metrics.js";

/**
 * Embeddings run locally. Two reasons: it removes a second vendor, and it means
 * retrieval still works with the network unplugged, which is a demo requirement
 * rather than a nicety.
 *
 * 384 dimensions. Must match the vector() width in packages/shared/src/schema.ts.
 */
export const EMBEDDING_MODEL = "Xenova/bge-small-en-v1.5";
export const EMBEDDING_DIMS = 384;

/**
 * Where the model is cached. Set here because nothing else sets it.
 *
 * The Dockerfile exports HF_HOME and TRANSFORMERS_CACHE, which belong to the
 * *Python* transformers library. transformers.js ignores both and defaults to a
 * `.cache` directory inside its own package under node_modules — which the
 * image's non-root `node` user cannot write to. Every download failed with
 * EACCES, so the model was never cached, the pipeline never resolved, and the
 * `models` volume the compose files carefully mount sat empty.
 *
 * The visible symptom was chunks stuck on "embedding" forever with a job that
 * looked like it was running. Nothing said "permission denied" above debug
 * level, and semantic search silently returned nothing while lexical search
 * kept working, so retrieval looked merely mediocre rather than broken.
 *
 * MODEL_CACHE_DIR overrides it. Outside a container /models does not exist and
 * / is not writable, so the fallback is a directory under the repo — `pnpm dev`
 * and the test run must not depend on a path that only exists in Docker.
 */
env.cacheDir =
  config.MODEL_CACHE_DIR ?? (existsSync("/models") ? "/models" : ".cache/models");

let extractor: Promise<FeatureExtractionPipeline> | null = null;

function getExtractor(): Promise<FeatureExtractionPipeline> {
  // First call downloads roughly 130MB into env.cacheDir. In Docker that path
  // is a volume, so it survives restarts.
  //
  // The catch clears the memo, and it is the whole point of this function.
  // `??=` caches the promise, so a rejected one is cached just as happily as a
  // fulfilled one: one failed load — a half-written cache, a network blip on
  // boot — and every later call re-awaits that same rejection for the lifetime
  // of the process. The retry budget then burns down against a failure that is
  // never retried, and restarting the container "fixes" it, which is the sort
  // of thing that gets written off as flakiness.
  extractor ??= pipeline("feature-extraction", EMBEDDING_MODEL).catch((error) => {
    extractor = null;
    throw error;
  });
  return extractor;
}

/**
 * The model's real input limit, in characters.
 *
 * `bge-small-en-v1.5` caps at 512 tokens and the pipeline hard-codes
 * `truncation: true`, so anything longer is silently dropped *inside* the
 * model — the vector comes back looking normal and simply does not represent
 * the tail. Rationale is accepted up to 4000 characters, roughly a thousand
 * tokens, so more than half a long handover note was absent from its own
 * embedding and unfindable by semantic search.
 *
 * At roughly four characters per token this leaves headroom under the cap.
 */
export const MAX_EMBED_CHARS = 1800;

/**
 * Embeds the whole text by averaging over windows when it is too long.
 *
 * Truncating would keep the opening and lose the conclusion, and in a
 * rationale the conclusion is the part worth finding. A mean of the window
 * vectors is the standard cheap approximation and it keeps every part of the
 * text represented — the vectors are already unit-normalised by the pooling
 * above, so averaging and re-normalising is well behaved.
 */
export function windowsOf(text: string): string[] {
  if (text.length <= MAX_EMBED_CHARS) return [text];

  const windows: string[] = [];
  // A quarter-window of overlap, so a sentence spanning a seam is whole in one.
  const stride = Math.floor(MAX_EMBED_CHARS * 0.75);
  for (let start = 0; start < text.length; start += stride) {
    windows.push(text.slice(start, start + MAX_EMBED_CHARS));
    if (start + MAX_EMBED_CHARS >= text.length) break;
  }
  return windows;
}

export function meanNormalized(vectors: number[][]): number[] {
  const first = vectors[0];
  if (!first) return [];
  if (vectors.length === 1) return first;

  const summed = new Array<number>(first.length).fill(0);
  for (const vector of vectors) {
    for (let i = 0; i < summed.length; i += 1) {
      summed[i] = (summed[i] ?? 0) + (vector[i] ?? 0);
    }
  }

  const magnitude = Math.sqrt(summed.reduce((acc, v) => acc + v * v, 0)) || 1;
  return summed.map((v) => v / magnitude);
}

/**
 * The name of whatever is producing vectors right now.
 *
 * Written to the database alongside the vectors so a provider swap is
 * detectable. Without it, changing EMBEDDING_PROVIDER silently leaves two
 * incompatible vector spaces in one column.
 */
export function activeEmbeddingModel(): string {
  return config.EMBEDDING_PROVIDER === "openrouter"
    ? `openrouter:${config.OPENROUTER_EMBEDDING_MODEL}`
    : `local:${EMBEDDING_MODEL}`;
}

/**
 * One batch of windows in, one vector per window out.
 *
 * The seam between the two providers is deliberately here rather than at
 * `embed`/`embedAll`: windowing, mean-pooling and re-normalising are properties
 * of how this codebase handles long text, not of who computes the vectors, and
 * duplicating them per provider is how the two drift apart.
 */
async function runWindows(windows: string[]): Promise<number[][]> {
  /**
   * The one seam both providers pass through, which is why the timing lives
   * here rather than in `embed`/`embedAll`. Those two differ only in how they
   * regroup the result, so instrumenting them would double-count a batch and
   * miss anything that reaches the model by another route.
   *
   * Failures are deliberately not observed: an exception is a provider being
   * down, and folding a fast failure into a latency histogram makes the p95
   * improve at exactly the moment embedding stops working.
   */
  const provider = config.EMBEDDING_PROVIDER === "openrouter" ? "openrouter" : "local";
  // Which model, not just which provider. Swapping the embedding model changes
  // both the latency profile and the vectors themselves, so a chart that could
  // not tell them apart would blend two incomparable distributions.
  const model =
    provider === "openrouter"
      ? (config.OPENROUTER_EMBEDDING_MODEL ?? "unknown")
      : EMBEDDING_MODEL;
  const started = performance.now();

  const vectors =
    provider === "openrouter" ? await embedRemote(windows) : await embedLocal(windows);

  embeddingDuration.observe(performance.now() - started, { provider, model });
  embeddingWindows.inc({ provider, model }, windows.length);
  return vectors;
}

async function embedLocal(windows: string[]): Promise<number[][]> {
  const run = await getExtractor();
  const output = await run(windows, { pooling: "mean", normalize: true });
  const flat = Array.from(output.data as Float32Array);
  return windows.map((_, i) => flat.slice(i * EMBEDDING_DIMS, (i + 1) * EMBEDDING_DIMS));
}

/**
 * OpenRouter's embeddings endpoint.
 *
 * Not routed through llm.ts: that module's token bucket and daily cap exist to
 * ration a 20-request-per-minute chat allowance, and embedding a backlog would
 * consume the budget the Historian and the CI analysis depend on. Embeddings
 * are a different product with different pricing, so they get their own path.
 *
 * The dimension check is not paranoia. A model returning 1024 or 2048 would be
 * rejected by Postgres on insert with a message about vector width, several
 * layers from the setting that caused it.
 */
async function embedRemote(texts: string[]): Promise<number[][]> {
  const key = requireEnv("OPENROUTER_API_KEY");
  const model = config.OPENROUTER_EMBEDDING_MODEL;

  const res = await fetch("https://openrouter.ai/api/v1/embeddings", {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({ model, input: texts }),
    signal: AbortSignal.timeout(60_000),
  });

  if (!res.ok) {
    throw new Error(`OpenRouter embeddings failed (${res.status}): ${await res.text()}`);
  }

  const body = (await res.json()) as {
    data?: Array<{ embedding: number[]; index: number }>;
  };
  const rows = body.data ?? [];
  if (rows.length !== texts.length) {
    throw new Error(
      `OpenRouter returned ${rows.length} embeddings for ${texts.length} inputs`,
    );
  }

  // Ordered by `index`, not by arrival. The API does not promise response order
  // and a silently transposed batch attaches every vector to the wrong text.
  const ordered = [...rows].sort((a, b) => a.index - b.index);

  for (const row of ordered) {
    if (row.embedding.length !== EMBEDDING_DIMS) {
      throw new Error(
        `${model} returns ${row.embedding.length}-dimension vectors; the schema stores ${EMBEDDING_DIMS}. Pick a ${EMBEDDING_DIMS}-dimension model or migrate the vector columns.`,
      );
    }
  }

  return ordered.map((row) => row.embedding);
}

export async function embed(text: string): Promise<number[]> {
  const windows = windowsOf(text);
  return meanNormalized(await runWindows(windows));
}

export async function embedAll(texts: string[]): Promise<number[][]> {
  // Flattened into one batch so a long text costs extra windows rather than an
  // extra round trip, then regrouped by which text each window came from.
  const windowed = texts.map(windowsOf);
  const vectors = await runWindows(windowed.flat());

  let cursor = 0;
  return windowed.map((windows) => {
    const slice = vectors.slice(cursor, cursor + windows.length);
    cursor += windows.length;
    return meanNormalized(slice);
  });
}

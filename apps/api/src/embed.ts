import { type FeatureExtractionPipeline, pipeline } from "@huggingface/transformers";

/**
 * Embeddings run locally. Two reasons: it removes a second vendor, and it means
 * retrieval still works with the network unplugged, which is a demo requirement
 * rather than a nicety.
 *
 * 384 dimensions. Must match the vector() width in packages/shared/src/schema.ts.
 */
export const EMBEDDING_MODEL = "Xenova/bge-small-en-v1.5";
export const EMBEDDING_DIMS = 384;

let extractor: Promise<FeatureExtractionPipeline> | null = null;

function getExtractor(): Promise<FeatureExtractionPipeline> {
  // First call downloads roughly 130MB into HF_HOME. In Docker that path is a
  // volume, so it survives restarts.
  extractor ??= pipeline("feature-extraction", EMBEDDING_MODEL);
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

export async function embed(text: string): Promise<number[]> {
  const run = await getExtractor();
  const windows = windowsOf(text);
  const output = await run(windows, { pooling: "mean", normalize: true });
  const flat = Array.from(output.data as Float32Array);

  return meanNormalized(
    windows.map((_, i) => flat.slice(i * EMBEDDING_DIMS, (i + 1) * EMBEDDING_DIMS)),
  );
}

export async function embedAll(texts: string[]): Promise<number[][]> {
  const run = await getExtractor();

  // Flattened into one batch so a long text costs extra windows rather than an
  // extra round trip, then regrouped by which text each window came from.
  const windowed = texts.map(windowsOf);
  const flatWindows = windowed.flat();

  const output = await run(flatWindows, { pooling: "mean", normalize: true });
  const flat = Array.from(output.data as Float32Array);

  const vectors = flatWindows.map((_, i) =>
    flat.slice(i * EMBEDDING_DIMS, (i + 1) * EMBEDDING_DIMS),
  );

  let cursor = 0;
  return windowed.map((windows) => {
    const slice = vectors.slice(cursor, cursor + windows.length);
    cursor += windows.length;
    return meanNormalized(slice);
  });
}

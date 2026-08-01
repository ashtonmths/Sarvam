import { pipeline, type FeatureExtractionPipeline } from "@huggingface/transformers";

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

export async function embed(text: string): Promise<number[]> {
  const run = await getExtractor();
  const output = await run(text, { pooling: "mean", normalize: true });
  return Array.from(output.data as Float32Array);
}

export async function embedAll(texts: string[]): Promise<number[][]> {
  const run = await getExtractor();
  const output = await run(texts, { pooling: "mean", normalize: true });
  const flat = Array.from(output.data as Float32Array);
  return texts.map((_, i) => flat.slice(i * EMBEDDING_DIMS, (i + 1) * EMBEDDING_DIMS));
}

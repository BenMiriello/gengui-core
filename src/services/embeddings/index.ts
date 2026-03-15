import type { StoredStoryNode } from '../graph/graph.service';
import {
  getEmbeddingProvider,
  getEmbeddingProviderForVersion,
} from './factory';

export {
  getEmbeddingProvider,
  getEmbeddingProviderForVersion,
} from './factory';
export type { EmbeddingProvider } from './provider.interface';

/**
 * Generate embedding for a single text.
 * @param text - Text to embed
 * @param model - Optional model name. If not provided, uses current default.
 */
export async function generateEmbedding(
  text: string,
  model?: string,
): Promise<number[]> {
  const provider = getEmbeddingProvider(model);

  const maxRetries = 3;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const embedding = await provider.embed(text);
      return embedding;
    } catch (error: unknown) {
      const isWrongDimension =
        error instanceof Error &&
        error.message?.includes('wrong embedding dimensions');
      if (isWrongDimension && attempt < maxRetries - 1) {
        console.log(
          `[WARN] Retrying embedding generation (attempt ${attempt + 2}/${maxRetries}) for text: ${text.substring(0, 50)}`,
        );
        await new Promise((resolve) =>
          setTimeout(resolve, 500 * (attempt + 1)),
        );
        continue;
      }
      throw error;
    }
  }

  throw new Error('Failed to generate embedding after retries');
}

/**
 * Generate embeddings for multiple texts in batch.
 * @param texts - Array of texts to embed
 * @param model - Optional model name. If not provided, uses current default.
 */
export async function generateEmbeddings(
  texts: string[],
  model?: string,
): Promise<number[][]> {
  if (texts.length === 0) return [];
  if (texts.length === 1) return [await generateEmbedding(texts[0], model)];

  const provider = getEmbeddingProvider(model);
  return provider.batchEmbed(texts);
}

/**
 * Generate embedding for a specific analysis version.
 * Uses the embedding model configured for that version.
 */
export async function generateEmbeddingForVersion(
  text: string,
  version: string,
): Promise<number[]> {
  const provider = getEmbeddingProviderForVersion(version);
  return provider.embed(text);
}

/**
 * Generate embeddings for a specific analysis version.
 * Uses the embedding model configured for that version.
 */
export async function generateEmbeddingsForVersion(
  texts: string[],
  version: string,
): Promise<number[][]> {
  if (texts.length === 0) return [];
  if (texts.length === 1)
    return [await generateEmbeddingForVersion(texts[0], version)];

  const provider = getEmbeddingProviderForVersion(version);
  return provider.batchEmbed(texts);
}

/**
 * Build embedding text from stored node (no passages field).
 * Mentions with source='extraction' should be passed separately if available.
 */
export function buildEmbeddingText(
  node: StoredStoryNode,
  extractionMentions?: Array<{ originalText: string }>,
): string {
  const name = node.name;
  const description = node.description || '';

  let extractionText = '';
  if (extractionMentions && extractionMentions.length > 0) {
    extractionText = extractionMentions
      .map((m) => m.originalText)
      .join(' ')
      .trim();
  }

  return `${name}: ${description}${extractionText ? ` | ${extractionText}` : ''}`;
}

import type { StoredStoryNode } from '../graph/graph.service';
import { getEmbeddingProvider } from './factory';

export { getEmbeddingProvider } from './factory';
export type { EmbeddingProvider } from './provider.interface';

export async function generateEmbedding(text: string): Promise<number[]> {
  const provider = getEmbeddingProvider();

  // Retry up to 3 times if OpenAI returns wrong dimensions
  const maxRetries = 3;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const embedding = await provider.embed(text);
      console.log(
        `[DEBUG] generateEmbedding: provider=${provider.name}, dimensions=${embedding.length}, textLength=${text.length}`,
      );
      return embedding;
    } catch (error: any) {
      const isWrongDimension = error.message?.includes('wrong embedding dimensions');
      if (isWrongDimension && attempt < maxRetries - 1) {
        console.log(`[WARN] Retrying embedding generation (attempt ${attempt + 2}/${maxRetries}) for text: ${text.substring(0, 50)}`);
        await new Promise(resolve => setTimeout(resolve, 500 * (attempt + 1)));
        continue;
      }
      throw error;
    }
  }

  throw new Error('Failed to generate embedding after retries');
}

export async function generateEmbeddings(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  if (texts.length === 1) return [await generateEmbedding(texts[0])];

  const provider = getEmbeddingProvider();
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

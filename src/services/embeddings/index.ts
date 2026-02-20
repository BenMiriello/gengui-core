import type { StoredStoryNode } from '../graph/graph.service';
import { getEmbeddingProvider } from './factory';

export { getEmbeddingProvider } from './factory';
export type { EmbeddingProvider } from './provider.interface';

export async function generateEmbedding(text: string): Promise<number[]> {
  const provider = getEmbeddingProvider();
  return provider.embed(text);
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

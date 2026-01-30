import type { StoryNodeResult } from '../../types/storyNodes';
import type { StoredStoryNode } from '../graph/graph.service';
import { getEmbeddingProvider } from './factory';

export { getEmbeddingProvider } from './factory';
export type { EmbeddingProvider } from './provider.interface';

export async function generateEmbedding(text: string): Promise<number[]> {
  const provider = getEmbeddingProvider();
  return provider.embed(text);
}

export function buildEmbeddingText(node: StoryNodeResult | StoredStoryNode): string {
  const name = node.name;
  const type = node.type;
  const description = node.description || '';

  let passages = '';
  if ('passages' in node && node.passages) {
    if (typeof node.passages === 'string') {
      try {
        const parsed = JSON.parse(node.passages);
        passages = Array.isArray(parsed)
          ? parsed.map((p: any) => p.text).join(' ')
          : '';
      } catch {
        passages = '';
      }
    } else if (Array.isArray(node.passages)) {
      passages = node.passages.map(p => p.text).join(' ');
    }
  }

  return `[${type}] ${name}: ${description}${passages ? ` | ${passages}` : ''}`;
}

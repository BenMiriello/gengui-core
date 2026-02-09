import { logger } from '../../../utils/logger';
import type { EmbeddingProvider } from '../provider.interface';

let openaiClient: any = null;
let initialized = false;

async function createClient() {
  const { default: OpenAI } = await import('openai');
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;
  return new OpenAI({ apiKey });
}

async function getClient() {
  if (!initialized) {
    initialized = true;
    openaiClient = await createClient();
    if (!openaiClient) {
      logger.warn('OPENAI_API_KEY not configured');
    }
  }
  return openaiClient;
}

const MODEL = 'text-embedding-3-small';
const DIMENSIONS = 1536;

export const openaiEmbeddingProvider: EmbeddingProvider = {
  name: 'openai',
  dimensions: DIMENSIONS,

  async embed(text: string): Promise<number[]> {
    const client = await getClient();
    if (!client) throw new Error('OpenAI client not configured');

    const response = await client.embeddings.create({
      model: MODEL,
      input: text,
      dimensions: DIMENSIONS,
    });

    return response.data[0].embedding;
  },

  async batchEmbed(texts: string[]): Promise<number[][]> {
    const client = await getClient();
    if (!client) throw new Error('OpenAI client not configured');

    const response = await client.embeddings.create({
      model: MODEL,
      input: texts,
      dimensions: DIMENSIONS,
    });

    return response.data.sort((a: any, b: any) => a.index - b.index).map((d: any) => d.embedding);
  },
};

import { logger } from '../../../utils/logger';
import type { EmbeddingProvider } from '../provider.interface';

type OpenAIClient = {
  embeddings: {
    create: (params: {
      model: string;
      input: string | string[];
      dimensions: number;
    }) => Promise<{
      data: Array<{ embedding: number[]; index: number }>;
    }>;
  };
};

let initPromise: Promise<OpenAIClient | null> | null = null;

async function createClient(): Promise<OpenAIClient | null> {
  const { default: OpenAI } = await import('openai');
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;
  return new OpenAI({ apiKey }) as OpenAIClient;
}

async function getClient(): Promise<OpenAIClient | null> {
  if (!initPromise) {
    initPromise = createClient()
      .then((client) => {
        if (!client) {
          logger.warn('OPENAI_API_KEY not configured');
        }
        return client;
      })
      .catch((err) => {
        initPromise = null;
        throw err;
      });
  }
  return await initPromise;
}

const MODEL = 'text-embedding-3-small';
const DIMENSIONS = 1536;

export const openaiEmbeddingProvider: EmbeddingProvider = {
  name: 'openai',
  dimensions: DIMENSIONS,

  async embed(text: string): Promise<number[]> {
    const client = await getClient();
    if (!client) throw new Error('OpenAI client not configured');

    console.log(
      `[DEBUG] OpenAI embed: model=${MODEL}, dimensions=${DIMENSIONS}, textLength=${text.length}`,
    );

    const response = await client.embeddings.create({
      model: MODEL,
      input: text,
      dimensions: DIMENSIONS,
    });

    const embedding = response.data[0].embedding;
    console.log(
      `[DEBUG] OpenAI embed result: received ${embedding.length} dimensions`,
    );

    // CRITICAL: OpenAI API intermittently returns wrong dimensions
    // If we get wrong dimensions, throw error to trigger retry at higher level
    if (embedding.length !== DIMENSIONS) {
      logger.error(
        {
          expected: DIMENSIONS,
          received: embedding.length,
          model: MODEL,
          textLength: text.length,
          textPreview: text.substring(0, 100),
        },
        'OpenAI API returned wrong embedding dimensions',
      );
      throw new Error(
        `OpenAI API returned ${embedding.length} dimensions, expected ${DIMENSIONS}`,
      );
    }

    return embedding;
  },

  async batchEmbed(texts: string[]): Promise<number[][]> {
    const client = await getClient();
    if (!client) throw new Error('OpenAI client not configured');

    const response = await client.embeddings.create({
      model: MODEL,
      input: texts,
      dimensions: DIMENSIONS,
    });

    return response.data
      .sort((a, b) => a.index - b.index)
      .map((d) => d.embedding);
  },
};

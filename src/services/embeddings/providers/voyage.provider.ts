import { logger } from '../../../utils/logger';
import type { EmbeddingProvider } from '../provider.interface';

type VoyageClient = {
  embed: (params: {
    input: string[];
    model: string;
    output_dimension?: number;
  }) => Promise<{
    data: Array<{ embedding: number[]; index: number }>;
  }>;
};

const MODEL = 'voyage-4-lite';
const DIMENSIONS = 1024;
const BATCH_SIZE = 128;

let initPromise: Promise<VoyageClient | null> | null = null;

async function createClient(): Promise<VoyageClient | null> {
  // Use require() because voyageai's ESM exports have a bug with directory imports
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { VoyageAIClient } = require('voyageai') as {
    VoyageAIClient: new (opts: { apiKey: string }) => VoyageClient;
  };
  const apiKey = process.env.VOYAGE_API_KEY;
  if (!apiKey) return null;
  return new VoyageAIClient({ apiKey });
}

async function getClient(): Promise<VoyageClient | null> {
  if (!initPromise) {
    initPromise = createClient()
      .then((client) => {
        if (!client) {
          logger.warn('VOYAGE_API_KEY not configured');
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

export const voyageEmbeddingProvider: EmbeddingProvider = {
  name: 'voyage',
  dimensions: DIMENSIONS,

  async embed(text: string): Promise<number[]> {
    const client = await getClient();
    if (!client) throw new Error('Voyage client not configured');

    const response = await client.embed({
      model: MODEL,
      input: [text],
      output_dimension: DIMENSIONS,
    });

    const embedding = response.data[0].embedding;

    if (embedding.length !== DIMENSIONS) {
      logger.error(
        {
          expected: DIMENSIONS,
          received: embedding.length,
          model: MODEL,
          textLength: text.length,
        },
        'Voyage API returned wrong embedding dimensions',
      );
      throw new Error(
        `Voyage API returned ${embedding.length} dimensions, expected ${DIMENSIONS}`,
      );
    }

    return embedding;
  },

  async batchEmbed(texts: string[]): Promise<number[][]> {
    const client = await getClient();
    if (!client) throw new Error('Voyage client not configured');

    if (texts.length === 0) return [];

    const results: number[][] = [];

    for (let i = 0; i < texts.length; i += BATCH_SIZE) {
      const batch = texts.slice(i, i + BATCH_SIZE);

      const response = await client.embed({
        model: MODEL,
        input: batch,
        output_dimension: DIMENSIONS,
      });

      const batchEmbeddings = response.data
        .sort((a, b) => a.index - b.index)
        .map((d) => d.embedding);

      results.push(...batchEmbeddings);

      if (i + BATCH_SIZE < texts.length) {
        await new Promise((resolve) => setImmediate(resolve));
      }
    }

    return results;
  },
};

import { config } from 'dotenv';
import { z } from 'zod';

config();

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.string().default('3000').transform(Number),
  LOG_LEVEL: z.enum(['error', 'warn', 'info', 'debug']).default('info'),
  DB_HOST: z.string().default('localhost'),
  DB_PORT: z.string().default('5432').transform(Number),
  DB_USER: z.string().default('gengui'),
  DB_PASSWORD: z.string().default('gengui_dev_pass'),
  DB_NAME: z.string().default('gengui_media'),
  DB_POOL_MAX: z.string().optional().transform((v) => (v ? Number(v) : undefined)),
  DB_IDLE_TIMEOUT: z.string().optional().transform((v) => (v ? Number(v) : undefined)),
  DB_CONNECT_TIMEOUT: z.string().optional().transform((v) => (v ? Number(v) : undefined)),
  MINIO_ENDPOINT: z.string().default('localhost'),
  MINIO_PORT: z.string().default('9000').transform(Number),
  MINIO_ACCESS_KEY: z.string().default('minioadmin'),
  MINIO_SECRET_KEY: z.string().default('minioadmin'),
  MINIO_BUCKET: z.string().default('media'),

  // Inference Provider Selection
  TEXT_INFERENCE_PROVIDER: z.enum(['gemini']).default('gemini'),
  IMAGE_INFERENCE_PROVIDER: z.enum(['local', 'runpod', 'gemini']).default('gemini'),
  EMBEDDING_PROVIDER: z.enum(['openai']).default('openai'),

  // Provider API Keys
  GEMINI_API_KEY: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  RUNPOD_API_KEY: z.string().optional(),
  RUNPOD_ENDPOINT_ID: z.string().optional(),
})
.refine(
  (data) => {
    if (data.TEXT_INFERENCE_PROVIDER === 'gemini' && !data.GEMINI_API_KEY) {
      return false;
    }
    if (data.IMAGE_INFERENCE_PROVIDER === 'gemini' && !data.GEMINI_API_KEY) {
      return false;
    }
    if (data.IMAGE_INFERENCE_PROVIDER === 'runpod') {
      return !!(data.RUNPOD_API_KEY && data.RUNPOD_ENDPOINT_ID);
    }
    if (data.EMBEDDING_PROVIDER === 'openai' && !data.OPENAI_API_KEY) {
      return false;
    }
    return true;
  },
  {
    message: 'Missing required API keys for selected inference provider(s)',
  }
);

function validateEnv() {
  try {
    return envSchema.parse(process.env);
  } catch (error) {
    if (error instanceof z.ZodError) {
      const errors = error.issues.map((err) => `${err.path.join('.')}: ${err.message}`);
      throw new Error(`Environment validation failed:\n${errors.join('\n')}`);
    }
    throw error;
  }
}

export const env = validateEnv();

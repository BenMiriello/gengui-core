import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from '../models/schema.js';
import { env } from './env';
import { logger } from '../utils/logger';

const isProd = env.NODE_ENV === 'production';
const isDev = env.NODE_ENV === 'development';

const poolConfig = {
  max: env.DB_POOL_MAX ?? (isProd ? 40 : 20),
  idle_timeout: env.DB_IDLE_TIMEOUT ?? 20,
  connect_timeout: env.DB_CONNECT_TIMEOUT ?? (isProd ? 5 : 10),
};

logger.info({
  max: poolConfig.max,
  environment: isProd ? 'production' : isDev ? 'development' : 'test',
}, 'Database pool configured');

const queryClient = postgres({
  host: env.DB_HOST,
  port: env.DB_PORT,
  username: env.DB_USER,
  password: env.DB_PASSWORD,
  database: env.DB_NAME,
  ...poolConfig,
  onnotice: () => {},
  ssl: isProd ? 'require' : false,
});

export const db = drizzle(queryClient, { schema });

export async function testConnection() {
  try {
    await queryClient`SELECT 1`;
    console.log('Database connection successful');
    return true;
  } catch (error) {
    console.error('Database connection failed:', error);
    return false;
  }
}

export async function closeDatabase() {
  await queryClient.end();
}

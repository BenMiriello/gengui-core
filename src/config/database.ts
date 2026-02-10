import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { env } from './env';

const isProd = env.NODE_ENV === 'production';

const queryClient = postgres({
  host: env.DB_HOST,
  port: env.DB_PORT,
  username: env.DB_USER,
  password: env.DB_PASSWORD,
  database: env.DB_NAME,
  max: env.DB_POOL_MAX ?? (isProd ? 10 : 5),
  idle_timeout: env.DB_IDLE_TIMEOUT ?? 20,
  connect_timeout: env.DB_CONNECT_TIMEOUT ?? (isProd ? 5 : 10),
  onnotice: () => {},
  ssl: isProd ? 'require' : false,
});

export const db = drizzle(queryClient);

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

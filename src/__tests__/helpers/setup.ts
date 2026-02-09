import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from 'dotenv';

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, '../../../.env.test') });

import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

let testClient: ReturnType<typeof postgres> | null = null;
let testDb: ReturnType<typeof drizzle> | null = null;

export async function getTestDb() {
  if (testDb) return testDb;

  testClient = postgres({
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT) || 5432,
    username: process.env.DB_USER || 'gengui',
    password: process.env.DB_PASSWORD || 'gengui_dev_pass',
    database: process.env.DB_NAME || 'gengui_test',
    max: 5,
    idle_timeout: 20,
    connect_timeout: 10,
    onnotice: () => {},
  });

  testDb = drizzle(testClient);
  return testDb;
}

export async function runMigrations() {
  const db = await getTestDb();
  const migrationsDir = resolve(__dirname, '../../../drizzle');

  const files = await readdir(migrationsDir);
  const sqlFiles = files.filter((f) => f.endsWith('.sql')).sort();

  for (const file of sqlFiles) {
    const filePath = join(migrationsDir, file);
    const content = await readFile(filePath, 'utf-8');

    const statements = content
      .split(/--> statement-breakpoint/g)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);

    for (const statement of statements) {
      if (statement) {
        try {
          await db.execute(sql.raw(statement));
        } catch (error: any) {
          if (
            !error.message.includes('already exists') &&
            !error.message.includes('duplicate key') &&
            !error.message.includes('does not exist') &&
            !error.message.includes('cannot drop')
          ) {
            console.error(`Migration error in ${file}:`, error.message);
          }
        }
      }
    }
  }
}

export async function truncateAll() {
  const db = await getTestDb();

  const tables = [
    'mentions',
    'document_versions',
    'document_media',
    'documents',
    'node_media',
    'story_node_connections',
    'story_nodes',
    'user_style_prompts',
    'model_inputs',
    'models',
    'media_tags',
    'tags',
    'media',
    'password_reset_tokens',
    'email_verification_tokens',
    'sessions',
    'users',
  ];

  for (const table of tables) {
    try {
      await db.execute(sql.raw(`TRUNCATE TABLE ${table} RESTART IDENTITY CASCADE`));
    } catch {
      // Table might not exist, which is fine
    }
  }
}

export async function closeDb() {
  if (testClient) {
    await testClient.end();
    testClient = null;
    testDb = null;
  }
}

export { testDb };

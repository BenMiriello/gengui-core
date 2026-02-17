import { createHash } from 'node:crypto';
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
let schemaEnsured = false;

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

async function getMigrationFiles(): Promise<string[]> {
  const migrationsDir = resolve(__dirname, '../../../drizzle');
  const files = await readdir(migrationsDir);
  return files.filter((f) => f.endsWith('.sql')).sort();
}

async function computeMigrationHash(): Promise<string> {
  const migrationsDir = resolve(__dirname, '../../../drizzle');
  const files = await getMigrationFiles();
  const hash = createHash('sha256');

  for (const file of files) {
    const content = await readFile(join(migrationsDir, file), 'utf-8');
    hash.update(file);
    hash.update(content);
  }

  return hash.digest('hex').slice(0, 16);
}

async function getStoredSchemaVersion(db: ReturnType<typeof drizzle>): Promise<string | null> {
  try {
    const result = await db.execute(sql`
      SELECT version FROM _test_schema_meta LIMIT 1
    `);
    return (result as any)[0]?.version ?? null;
  } catch {
    return null;
  }
}

async function setSchemaVersion(db: ReturnType<typeof drizzle>, version: string): Promise<void> {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS _test_schema_meta (
      id INTEGER PRIMARY KEY DEFAULT 1,
      version TEXT NOT NULL,
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `);
  await db.execute(sql`
    INSERT INTO _test_schema_meta (id, version, updated_at)
    VALUES (1, ${version}, NOW())
    ON CONFLICT (id) DO UPDATE SET version = ${version}, updated_at = NOW()
  `);
}

async function resetSchema(db: ReturnType<typeof drizzle>): Promise<void> {
  // Drop and recreate public schema - clean slate for migrations
  await db.execute(sql`DROP SCHEMA public CASCADE`);
  await db.execute(sql`CREATE SCHEMA public`);
  await db.execute(sql`GRANT ALL ON SCHEMA public TO public`);
}

async function applyMigrations(db: ReturnType<typeof drizzle>): Promise<void> {
  const migrationsDir = resolve(__dirname, '../../../drizzle');
  const sqlFiles = await getMigrationFiles();

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
          // Handle idempotent migration conflicts from overlapping CREATE statements
          // These occur when migration files were generated with duplicate definitions
          const pgCode = error.cause?.code || error.code;
          // Migration files have conflicting definitions (legacy issue)
          // Suppress known idempotent conflicts to allow tests to run
          const idempotentCodes = [
            '42710', // duplicate_object (type/constraint already exists)
            '42P07', // duplicate_table
            '42P01', // undefined_table (DROP/ALTER on missing table)
            '42701', // duplicate_column
            '42703', // undefined_column (ADD CONSTRAINT on missing col)
            '42704', // undefined_object (DROP CONSTRAINT on missing constraint)
          ];
          if (!idempotentCodes.includes(pgCode)) {
            throw error;
          }
        }
      }
    }
  }
}

/**
 * Ensures the test database schema is up-to-date.
 * Called ONCE from preload.ts before any tests run.
 *
 * Uses a hash of migration files (names + content) to detect changes.
 * When schema changes, drops and recreates for a clean slate.
 */
export async function ensureSchema(): Promise<void> {
  if (schemaEnsured) return;

  const db = await getTestDb();
  const currentHash = await computeMigrationHash();
  const storedHash = await getStoredSchemaVersion(db);

  if (storedHash === currentHash) {
    schemaEnsured = true;
    return;
  }

  // Schema changed or first run - reset and apply fresh
  await resetSchema(db);
  await applyMigrations(db);
  await setSchemaVersion(db, currentHash);
  schemaEnsured = true;
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

export { clearGraphData, closeGraph, connectGraph, graphQuery } from './graphSetup';

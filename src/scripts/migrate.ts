import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import 'dotenv/config';
import postgres from 'postgres';

const DB_HOST = process.env.DB_HOST || 'localhost';
const DB_PORT = Number(process.env.DB_PORT) || 5432;
const DB_USER = process.env.DB_USER || 'gengui';
const DB_PASSWORD = process.env.DB_PASSWORD || 'gengui_dev_pass';
const DB_NAME = process.env.DB_NAME || 'gengui_media';
const isProd = process.env.NODE_ENV === 'production';

function getMigrationsFolder(): string {
  // Works for both:
  // - Source: bun src/scripts/migrate.ts -> __dirname = .../core/src/scripts
  // - Dist: node dist/scripts/migrate.js -> __dirname = .../core/dist/scripts
  // Both resolve to .../core/drizzle
  const coreRoot = path.resolve(__dirname, '../..');
  return path.join(coreRoot, 'drizzle');
}

async function runMigrations(): Promise<void> {
  console.log('Starting database migrations...');
  console.log(`Target: ${DB_HOST}:${DB_PORT}/${DB_NAME}`);
  console.log(`Environment: ${isProd ? 'production' : 'development'}`);

  const sql = postgres({
    host: DB_HOST,
    port: DB_PORT,
    username: DB_USER,
    password: DB_PASSWORD,
    database: DB_NAME,
    max: 1,
    ssl: isProd ? 'require' : false,
    connect_timeout: 30,
    idle_timeout: 60,
    onnotice: (notice) => console.log(`[PG NOTICE] ${notice.message}`),
  });

  try {
    // Create migrations tracking table if not exists
    await sql`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version VARCHAR(255) PRIMARY KEY,
        applied_at TIMESTAMP WITH TIME ZONE DEFAULT NOW() NOT NULL
      )
    `;

    // Get already-applied migrations
    const applied = await sql<{ version: string }[]>`
      SELECT version FROM schema_migrations ORDER BY version
    `;
    const appliedSet = new Set(applied.map((r) => r.version));

    // Read migration files
    const migrationsFolder = getMigrationsFolder();
    console.log(`Migrations folder: ${migrationsFolder}`);

    const files = fs
      .readdirSync(migrationsFolder)
      .filter((f) => f.endsWith('.sql'))
      .sort();

    let appliedCount = 0;
    let skippedCount = 0;

    for (const file of files) {
      const version = file.replace('.sql', '');

      if (appliedSet.has(version)) {
        console.log(`  [SKIP] ${version} (already applied)`);
        skippedCount++;
        continue;
      }

      console.log(`[APPLYING] ${version}...`);

      const filePath = path.join(migrationsFolder, file);
      const content = fs.readFileSync(filePath, 'utf-8');

      // Baseline migrations (like 0000_baseline.sql) are applied via psql
      // because they're large pg_dump files that work best with psql
      if (version.startsWith('0000_')) {
        const psqlEnv = {
          PGHOST: DB_HOST,
          PGPORT: DB_PORT.toString(),
          PGUSER: DB_USER,
          PGPASSWORD: DB_PASSWORD,
          PGDATABASE: DB_NAME,
        };
        execSync(`psql -f "${filePath}"`, {
          env: { ...process.env, ...psqlEnv },
          stdio: 'pipe',
        });
        await sql`
          INSERT INTO schema_migrations (version)
          VALUES (${version})
          ON CONFLICT DO NOTHING
        `;
      } else {
        // Execute regular migrations in a transaction
        await sql.begin(async (tx) => {
          await tx.unsafe(content);
          await tx`
            INSERT INTO schema_migrations (version)
            VALUES (${version})
            ON CONFLICT DO NOTHING
          `;
        });
      }

      console.log(`[DONE] ${version}`);
      appliedCount++;
    }

    console.log('');
    console.log(
      `Migrations completed: ${appliedCount} applied, ${skippedCount} already applied`,
    );
  } catch (error) {
    console.error('Migration failed:', error);
    await sql.end();
    process.exit(1);
  }

  await sql.end();
  process.exit(0);
}

runMigrations();

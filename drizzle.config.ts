import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './src/models/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT) || 5432,
    user: process.env.DB_USER || 'gengui',
    password: process.env.DB_PASSWORD || 'gengui_dev_pass',
    database: process.env.DB_NAME || 'gengui_media',
  },
});

-- Migration 0025: Remove legacy Postgres story_nodes system
-- Nodes now live in FalkorDB (graph database), not Postgres
-- node_media.node_id references FalkorDB node UUIDs (stored as varchar)

-- 0. Create migration tracking table (if not exists)
CREATE TABLE IF NOT EXISTS "schema_migrations" (
  "version" VARCHAR(255) PRIMARY KEY,
  "applied_at" TIMESTAMP WITH TIME ZONE DEFAULT NOW() NOT NULL
);

-- 1. Drop FK constraint on node_media.node_id
ALTER TABLE "node_media" DROP CONSTRAINT IF EXISTS "node_media_node_id_story_nodes_id_fk";
ALTER TABLE "node_media" DROP CONSTRAINT IF EXISTS "node_media_node_id_fkey";

-- 2. Change node_id from UUID to VARCHAR(255) to match FalkorDB node IDs
ALTER TABLE "node_media" ALTER COLUMN "node_id" TYPE VARCHAR(255);

-- 3. Drop legacy tables (nodes now in FalkorDB)
DROP TABLE IF EXISTS "story_node_connections" CASCADE;
DROP TABLE IF EXISTS "story_nodes" CASCADE;

-- 4. Drop legacy enum type
DROP TYPE IF EXISTS "story_node_type";

-- 5. Record this migration
INSERT INTO "schema_migrations" ("version") VALUES ('0025_drop_node_media_fk')
ON CONFLICT ("version") DO NOTHING;

-- Character Consistency Schema Migration
-- Adds support for character sheets, node-media associations, and soft deletes

-- 1. Rename media.type column to source_type (and rename the enum for clarity)
ALTER TYPE media_type RENAME TO source_type;
ALTER TABLE media RENAME COLUMN type TO source_type;

-- Rename indexes that referenced old column name
DROP INDEX IF EXISTS media_type_status_idx;
DROP INDEX IF EXISTS media_user_type_idx;
CREATE INDEX media_source_type_status_idx ON media(source_type, status);
CREATE INDEX media_user_source_type_idx ON media(user_id, source_type);

-- 2. Add new columns to media table
ALTER TABLE media ADD COLUMN media_role VARCHAR(20);
ALTER TABLE media ADD COLUMN generation_settings JSONB;
ALTER TABLE media ADD COLUMN generation_settings_schema_version INTEGER;

-- Index for filtering by media_role
CREATE INDEX idx_media_role ON media(media_role) WHERE media_role IS NOT NULL;

-- 3. Add soft delete and primary_media_id to story_nodes
ALTER TABLE story_nodes ADD COLUMN deleted_at TIMESTAMP;
ALTER TABLE story_nodes ADD COLUMN primary_media_id UUID REFERENCES media(id);

-- Index for active nodes (soft delete filter)
CREATE INDEX idx_story_nodes_active ON story_nodes(document_id, user_id) WHERE deleted_at IS NULL;

-- 4. Add soft delete to story_node_connections
ALTER TABLE story_node_connections ADD COLUMN deleted_at TIMESTAMP;

-- Index for active connections
CREATE INDEX idx_story_node_connections_active ON story_node_connections(from_node_id, to_node_id) WHERE deleted_at IS NULL;

-- 5. Create node_media joiner table
CREATE TABLE node_media (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  node_id UUID NOT NULL REFERENCES story_nodes(id) ON DELETE CASCADE,
  media_id UUID NOT NULL REFERENCES media(id) ON DELETE CASCADE,
  created_at TIMESTAMP DEFAULT NOW() NOT NULL,
  deleted_at TIMESTAMP,
  UNIQUE(node_id, media_id)
);

CREATE INDEX idx_node_media_node ON node_media(node_id) WHERE deleted_at IS NULL;
CREATE INDEX idx_node_media_media ON node_media(media_id) WHERE deleted_at IS NULL;

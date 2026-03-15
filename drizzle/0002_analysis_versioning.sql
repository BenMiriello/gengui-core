-- Analysis Versioning Migration
-- Adds support for multiple embedding models with per-document version tracking

-- Rollback commands (run in reverse order):
-- DROP INDEX IF EXISTS idx_sentence_embeddings_vector_1024;
-- DROP INDEX IF EXISTS idx_sentence_embeddings_hash_model;
-- ALTER INDEX idx_sentence_embeddings_vector_1536 RENAME TO idx_sentence_embeddings_vector;
-- ALTER TABLE sentence_embeddings DROP COLUMN embedding_1024;
-- ALTER TABLE sentence_embeddings DROP COLUMN embedding_model;
-- ALTER TABLE sentence_embeddings RENAME COLUMN embedding_1536 TO embedding;
-- ALTER TABLE documents DROP COLUMN analysis_version;
-- CREATE INDEX idx_sentence_embeddings_hash ON sentence_embeddings (content_hash);

-- 1. Documents: add analysis_version column
ALTER TABLE documents ADD COLUMN IF NOT EXISTS analysis_version VARCHAR(20);

-- 2. Sentence embeddings: add embedding_model column (nullable initially for backfill)
ALTER TABLE sentence_embeddings ADD COLUMN IF NOT EXISTS embedding_model VARCHAR(50);

-- 3. Rename embedding column to embedding_1536
ALTER TABLE sentence_embeddings RENAME COLUMN embedding TO embedding_1536;

-- 4. Add embedding_1024 column for Voyage embeddings
ALTER TABLE sentence_embeddings ADD COLUMN IF NOT EXISTS embedding_1024 vector(1024);

-- 5. Backfill existing data BEFORE adding NOT NULL constraint
-- Mark all existing analyzed documents as version 0.0.1
UPDATE documents
SET analysis_version = '0.0.1'
WHERE last_analyzed_version IS NOT NULL AND analysis_version IS NULL;

-- Mark all existing embeddings as openai-3-small
UPDATE sentence_embeddings
SET embedding_model = 'openai-3-small'
WHERE embedding_model IS NULL;

-- 6. Add NOT NULL constraint after backfill
ALTER TABLE sentence_embeddings ALTER COLUMN embedding_model SET NOT NULL;

-- 7. Update indexes
-- Drop old hash index
DROP INDEX IF EXISTS idx_sentence_embeddings_hash;

-- Create composite index for cache lookups (hash + model)
CREATE INDEX IF NOT EXISTS idx_sentence_embeddings_hash_model
ON sentence_embeddings (content_hash, embedding_model);

-- Rename existing vector index
ALTER INDEX idx_sentence_embeddings_vector RENAME TO idx_sentence_embeddings_vector_1536;

-- Create new vector index for 1024-dim embeddings
CREATE INDEX IF NOT EXISTS idx_sentence_embeddings_vector_1024
ON sentence_embeddings USING hnsw (embedding_1024 vector_cosine_ops)
WITH (m = 16, ef_construction = 64);

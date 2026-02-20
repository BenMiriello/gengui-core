-- Enable pgvector extension if not already enabled
CREATE EXTENSION IF NOT EXISTS vector;

-- Sentence embeddings table for semantic search within segments
CREATE TABLE IF NOT EXISTS sentence_embeddings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  segment_id VARCHAR(255) NOT NULL,
  sentence_start INTEGER NOT NULL,
  sentence_end INTEGER NOT NULL,
  content_hash VARCHAR(64) NOT NULL,
  embedding vector(1536) NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

-- Indexes for efficient lookups
CREATE INDEX idx_sentence_embeddings_document ON sentence_embeddings(document_id);
CREATE INDEX idx_sentence_embeddings_segment ON sentence_embeddings(document_id, segment_id);
CREATE INDEX idx_sentence_embeddings_hash ON sentence_embeddings(content_hash);

-- HNSW index for vector similarity search
CREATE INDEX idx_sentence_embeddings_vector ON sentence_embeddings
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

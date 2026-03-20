-- Make embedding_1536 nullable to support v0.0.2 (Voyage 1024-dim) embeddings
-- v0.0.1 used OpenAI 1536-dim, v0.0.2 uses Voyage 1024-dim
-- Each version stores in its respective column, so both must be nullable

ALTER TABLE sentence_embeddings
ALTER COLUMN embedding_1536 DROP NOT NULL;

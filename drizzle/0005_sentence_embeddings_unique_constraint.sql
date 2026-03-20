-- Add unique constraint for UPSERT support on sentence embeddings
-- This allows re-running analysis without duplicate key errors
-- Includes embedding_model so different models get separate rows for same position

ALTER TABLE sentence_embeddings
ADD CONSTRAINT sentence_embeddings_unique_position
UNIQUE (document_id, segment_id, sentence_start, sentence_end, embedding_model);

-- Add summary fields to documents table
-- Per TDD 2026-02-21 Section 10: Progressive updates for summaries

ALTER TABLE documents
ADD COLUMN summary TEXT,
ADD COLUMN summary_edit_chain_length INTEGER DEFAULT 0 NOT NULL,
ADD COLUMN summary_updated_at TIMESTAMP WITH TIME ZONE;

-- Index for documents that need summary regeneration (edit chain too long)
CREATE INDEX idx_documents_summary_chain ON documents (summary_edit_chain_length)
WHERE summary_edit_chain_length >= 10;

COMMENT ON COLUMN documents.summary IS 'LLM-generated document summary, updated progressively via diffs';
COMMENT ON COLUMN documents.summary_edit_chain_length IS 'Number of edit updates since last full regeneration (reset at 10)';
COMMENT ON COLUMN documents.summary_updated_at IS 'When summary was last updated';

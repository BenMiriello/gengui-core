-- Rollback: DROP INDEX IF EXISTS idx_mentions_doc_updated;

-- React Query Last-Modified timestamp indexes
-- Enables O(1) timestamp checks for 304 responses

-- Mentions: Get most recent update per document
CREATE INDEX IF NOT EXISTS idx_mentions_doc_updated
ON mentions(document_id, updated_at DESC);

-- Note: Nodes are stored in FalkorDB (graph DB), not Postgres
-- Node timestamps are tracked via graph database queries

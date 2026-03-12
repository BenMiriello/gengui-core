-- Analysis snapshots store sentence hashes at analysis time for staleness detection
CREATE TABLE IF NOT EXISTS analysis_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  version_number INTEGER NOT NULL,
  sentence_index INTEGER NOT NULL,
  sentence_start INTEGER NOT NULL,
  sentence_end INTEGER NOT NULL,
  content_hash VARCHAR(64) NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

-- Index for efficient lookup by document and version
CREATE INDEX idx_analysis_snapshots_doc_version
  ON analysis_snapshots(document_id, version_number);

-- Unique constraint: one entry per sentence per version
CREATE UNIQUE INDEX idx_analysis_snapshots_unique
  ON analysis_snapshots(document_id, version_number, sentence_index);

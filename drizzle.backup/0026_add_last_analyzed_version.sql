-- Add lastAnalyzedVersion to documents for tracking analysis state
ALTER TABLE documents ADD COLUMN last_analyzed_version INTEGER;

-- Create index for efficient querying of documents needing reanalysis
CREATE INDEX IF NOT EXISTS documents_analysis_state_idx ON documents (last_analyzed_version, current_version);

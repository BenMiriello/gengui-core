-- Add missing analysisCompletedAt field
ALTER TABLE documents
ADD COLUMN analysis_completed_at TIMESTAMP WITH TIME ZONE;

COMMENT ON COLUMN documents.analysis_completed_at IS
  'Timestamp when analysis successfully completed (null if failed/incomplete)';

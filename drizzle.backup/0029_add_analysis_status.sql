-- Add analysis status tracking columns
ALTER TABLE documents ADD COLUMN analysis_status text;
ALTER TABLE documents ADD COLUMN analysis_started_at timestamp;

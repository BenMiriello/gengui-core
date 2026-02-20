-- Migration: Add analysis checkpoint column for pipeline resumability
ALTER TABLE documents ADD COLUMN analysis_checkpoint JSONB;

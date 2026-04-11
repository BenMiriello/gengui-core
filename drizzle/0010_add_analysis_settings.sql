ALTER TABLE documents ADD COLUMN IF NOT EXISTS analysis_settings jsonb DEFAULT '{}';

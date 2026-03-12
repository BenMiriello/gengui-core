-- Re-create document_versions table for version history
-- This table was dropped in 0014 but is required by the versioning service

CREATE TABLE IF NOT EXISTS document_versions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    version_number INTEGER NOT NULL,
    yjs_state TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW() NOT NULL,
    UNIQUE(document_id, version_number)
);

-- Add current_version column to documents if it doesn't exist
ALTER TABLE documents ADD COLUMN IF NOT EXISTS current_version INTEGER DEFAULT 0 NOT NULL;

-- Add segment_sequence column to documents if it doesn't exist
ALTER TABLE documents ADD COLUMN IF NOT EXISTS segment_sequence JSONB DEFAULT '[]'::jsonb NOT NULL;

-- Add yjs_state column to documents if it doesn't exist
ALTER TABLE documents ADD COLUMN IF NOT EXISTS yjs_state TEXT;

CREATE INDEX IF NOT EXISTS document_versions_lookup_idx ON document_versions(document_id, version_number);

-- Add document_id column to activities table
-- This enables navigation context for activity items (e.g., image generation -> document media section)

ALTER TABLE activities
ADD COLUMN document_id UUID REFERENCES documents(id) ON DELETE SET NULL;

-- Backfill documentId for existing image_generation activities from document_media
UPDATE activities a
SET document_id = dm.document_id
FROM document_media dm
WHERE a.media_id = dm.media_id
  AND a.activity_type = 'image_generation'
  AND a.document_id IS NULL;

-- Index for efficient lookups by document (after backfill for performance)
CREATE INDEX idx_activities_document ON activities(document_id) WHERE document_id IS NOT NULL;

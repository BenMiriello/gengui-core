-- Drop version_id column from document_media (no longer needed after versioning removal)
ALTER TABLE "document_media" DROP COLUMN IF EXISTS "version_id";

-- Drop foreign key constraints
ALTER TABLE "documents" DROP CONSTRAINT IF EXISTS "documents_current_version_id_document_versions_id_fk";--> statement-breakpoint
ALTER TABLE "document_media" DROP CONSTRAINT IF EXISTS "document_media_version_id_document_versions_id_fk";--> statement-breakpoint
ALTER TABLE "document_versions" DROP CONSTRAINT IF EXISTS "document_versions_document_id_documents_id_fk";--> statement-breakpoint
ALTER TABLE "document_versions" DROP CONSTRAINT IF EXISTS "document_versions_parent_version_id_document_versions_id_fk";--> statement-breakpoint

-- Drop indexes
DROP INDEX IF EXISTS "documents_current_version_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "document_media_version_id_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "document_versions_document_id_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "document_versions_parent_version_id_idx";--> statement-breakpoint

-- Drop columns
ALTER TABLE "documents" DROP COLUMN IF EXISTS "version";--> statement-breakpoint
ALTER TABLE "documents" DROP COLUMN IF EXISTS "current_version_id";--> statement-breakpoint
ALTER TABLE "document_media" DROP COLUMN IF EXISTS "version_id";--> statement-breakpoint

-- Drop table
DROP TABLE IF EXISTS "document_versions";--> statement-breakpoint

-- Drop enums
DROP TYPE IF EXISTS "change_type";--> statement-breakpoint
DROP TYPE IF EXISTS "version_format";

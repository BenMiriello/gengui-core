CREATE TYPE "public"."version_format" AS ENUM('snapshot', 'prosemirror');--> statement-breakpoint
ALTER TABLE "document_versions" ALTER COLUMN "diff" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "document_versions" ADD COLUMN "steps" jsonb;--> statement-breakpoint
ALTER TABLE "document_versions" ADD COLUMN "snapshot_content" jsonb;--> statement-breakpoint
ALTER TABLE "document_versions" ADD COLUMN "format" "version_format" DEFAULT 'snapshot' NOT NULL;
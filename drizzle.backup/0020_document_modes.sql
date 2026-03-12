-- Add mode columns to documents
ALTER TABLE "documents" ADD COLUMN "narrative_mode_enabled" boolean DEFAULT false NOT NULL;
ALTER TABLE "documents" ADD COLUMN "media_mode_enabled" boolean DEFAULT false NOT NULL;

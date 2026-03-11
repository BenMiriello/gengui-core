-- Backfill schema_migrations table with all existing migrations
-- Run this ONCE on production to mark all currently-applied migrations as tracked
--
-- Usage: psql -h <prod-host> -U gengui -d gengui_media -f scripts/backfill-migrations.sql

-- First, ensure the table exists
CREATE TABLE IF NOT EXISTS schema_migrations (
  version VARCHAR(255) PRIMARY KEY,
  applied_at TIMESTAMP WITH TIME ZONE DEFAULT NOW() NOT NULL
);

-- Insert all migration records (ON CONFLICT DO NOTHING means it's safe to re-run)
-- These are all migrations that exist in drizzle/ folder
INSERT INTO schema_migrations (version, applied_at) VALUES
  ('0000_clumsy_donald_blake', NOW()),
  ('0001_steady_warpath', NOW()),
  ('0002_easy_lila_cheney', NOW()),
  ('0003_wakeful_dark_phoenix', NOW()),
  ('0004_flippant_solo', NOW()),
  ('0005_add_media_tags', NOW()),
  ('0006_add_cover_images_updated_at_to_documents', NOW()),
  ('0007_add_document_deletion_columns', NOW()),
  ('0008_add_media_deletion_columns', NOW()),
  ('0009_add_sessions_table', NOW()),
  ('0010_add_created_at_and_deleted_at_to_users', NOW()),
  ('0011_add_cover_media_id_to_documents', NOW()),
  ('0012_drop_cover_images', NOW()),
  ('0013_add_documents_deleted_at_index', NOW()),
  ('0014_make_doc_user_id_nullable', NOW()),
  ('0015_make_media_user_id_nullable', NOW()),
  ('0016_add_image_generations_table', NOW()),
  ('0017_talented_red_skull', NOW()),
  ('0018_add_refresh_token_column', NOW()),
  ('0019_add_user_preferences_columns', NOW()),
  ('0020_drop_media_tags', NOW()),
  ('0021_add_node_media_table', NOW()),
  ('0022_add_annotations_table', NOW()),
  ('0023_add_annotation_index', NOW()),
  ('0024_add_media_primary_node_index', NOW()),
  ('0025_drop_node_media_fk', NOW()),
  ('0026_add_cascade_delete_media_annotations', NOW()),
  ('0027_add_media_character_count', NOW()),
  ('0028_add_media_transcript_wordcount', NOW()),
  ('0029_add_custom_style_prompts', NOW()),
  ('0030_add_aspect_ratio_support', NOW()),
  ('0031_add_character_count_function', NOW()),
  ('0032_add_image_generation_cascade_deletes', NOW()),
  ('0033_add_document_id_to_image_generations', NOW()),
  ('0034_add_media_ref_to_image_generations', NOW()),
  ('0035_add_image_generation_timestamps', NOW()),
  ('0036_add_image_generation_dimensions', NOW()),
  ('0037_add_version_info_to_media', NOW()),
  ('0038_media_parent_index', NOW()),
  ('0039_add_lock_detection', NOW()),
  ('0040_add_auth_logging', NOW()),
  ('0041_remove_annotation_content', NOW()),
  ('0042_create_jobs_table', NOW()),
  ('0043_add_pdf_export_job_type', NOW()),
  ('0044_add_docx_export_job_type', NOW()),
  ('0045_add_image_usage_tracking', NOW()),
  ('0046_google_drive_tokens', NOW()),
  ('0047_add_activities_table', NOW()),
  ('0048_user_soft_delete', NOW()),
  ('0049_drive_activity_types', NOW()),
  ('0050_add_activities_unviewed_index', NOW()),
  ('0051_add_image_generation_job_type', NOW())
ON CONFLICT (version) DO NOTHING;

-- Verify
SELECT COUNT(*) as total_migrations FROM schema_migrations;
SELECT version FROM schema_migrations ORDER BY version LIMIT 5;
SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 5;

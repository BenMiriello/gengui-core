-- Add is_key_passage column to mentions table
-- Defaults: true for extraction mentions, false for name_match mentions

ALTER TABLE mentions
ADD COLUMN is_key_passage BOOLEAN NOT NULL DEFAULT false;

-- Set true for existing extraction mentions
UPDATE mentions
SET is_key_passage = true
WHERE source = 'extraction';

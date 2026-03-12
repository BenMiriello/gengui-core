ALTER TABLE mentions ADD COLUMN IF NOT EXISTS facet_id UUID;
CREATE INDEX IF NOT EXISTS idx_mentions_facet ON mentions(facet_id) WHERE facet_id IS NOT NULL;

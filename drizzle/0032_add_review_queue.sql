-- Review queue for user review of LLM-detected conflicts
-- Per TDD 2026-02-21 Section 7.3

CREATE TYPE review_item_type AS ENUM (
  'contradiction',
  'merge_suggestion',
  'gap_detected',
  'low_confidence'
);

CREATE TABLE review_queue (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  item_type review_item_type NOT NULL,

  primary_entity_id VARCHAR(255),
  secondary_entity_id VARCHAR(255),
  facet_ids VARCHAR(255)[],
  state_ids VARCHAR(255)[],

  context_summary TEXT NOT NULL,
  source_positions JSONB,
  conflict_type VARCHAR(50),
  similarity REAL,

  status VARCHAR(20) DEFAULT 'pending' NOT NULL,
  resolved_at TIMESTAMPTZ,
  resolved_by UUID REFERENCES users(id),
  resolution JSONB,

  created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

CREATE INDEX idx_review_queue_document
  ON review_queue(document_id, status, created_at DESC);

CREATE INDEX idx_review_queue_status
  ON review_queue(status) WHERE status = 'pending';

CREATE INDEX idx_review_queue_entity
  ON review_queue(primary_entity_id) WHERE primary_entity_id IS NOT NULL;

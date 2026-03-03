-- Change log for audit trail of all entity/facet/edge/mention/etc operations
-- Append-only, immutable records

CREATE TYPE change_source AS ENUM ('user', 'system');

CREATE TABLE change_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,

  -- Who made the change
  source change_source NOT NULL,

  -- What changed
  target_type VARCHAR(30) NOT NULL,
  target_id VARCHAR(255) NOT NULL,
  operation VARCHAR(20) NOT NULL,

  -- Entity-centric query optimization
  related_entity_ids VARCHAR(255)[] NOT NULL DEFAULT '{}',

  -- Human-readable summary (generated at write time)
  summary TEXT NOT NULL,

  -- Structured change data (full before/after content)
  change_data JSONB NOT NULL,

  -- LLM explanation (nullable, only present for system changes with reasoning)
  reason TEXT,

  -- Link to source text position (nullable)
  source_position INTEGER,

  -- For compound operations (merge, batch extraction)
  batch_id UUID
);

-- Primary: entity-centric queries ("all changes affecting entity X")
CREATE INDEX idx_change_log_entities
  ON change_log USING GIN(related_entity_ids);

-- Time-range queries (BRIN is space-efficient for append-only)
CREATE INDEX idx_change_log_time
  ON change_log USING BRIN(created_at);

-- Direct target lookup
CREATE INDEX idx_change_log_target
  ON change_log(target_type, target_id);

-- Batch grouping
CREATE INDEX idx_change_log_batch
  ON change_log(batch_id)
  WHERE batch_id IS NOT NULL;

-- Constraints
ALTER TABLE change_log ADD CONSTRAINT valid_target_type CHECK (
  target_type IN ('entity', 'facet', 'edge', 'mention', 'character_state', 'arc', 'thread')
);

ALTER TABLE change_log ADD CONSTRAINT valid_operation CHECK (
  operation IN ('create', 'update', 'delete', 'merge')
);

COMMENT ON TABLE change_log IS 'Immutable audit trail for all graph and mention operations';
COMMENT ON COLUMN change_log.related_entity_ids IS 'Entity IDs affected by this change, for efficient entity-centric queries';
COMMENT ON COLUMN change_log.summary IS 'Human-readable summary generated at write time';
COMMENT ON COLUMN change_log.change_data IS 'Full before/after content as JSONB';
COMMENT ON COLUMN change_log.reason IS 'LLM reasoning for system-generated changes';
COMMENT ON COLUMN change_log.batch_id IS 'Groups related changes from same operation (merge, extraction batch)';

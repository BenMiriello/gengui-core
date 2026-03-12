-- Raw LLM operation tracking
CREATE TABLE llm_usage (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Correlation
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  document_id UUID REFERENCES documents(id) ON DELETE CASCADE,
  request_id UUID,

  -- Operation details
  operation VARCHAR(100) NOT NULL,
  model VARCHAR(50) NOT NULL DEFAULT 'gemini-2.0-flash',

  -- Token counts (real from API usageMetadata)
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,

  -- Cost (pre-calculated from pricing table)
  cost_usd DECIMAL(10,6) NOT NULL,

  -- Metadata
  duration_ms INTEGER,
  stage INTEGER,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes for fast queries
CREATE INDEX llm_usage_user_date_idx ON llm_usage (user_id, created_at);
CREATE INDEX llm_usage_date_idx ON llm_usage (created_at);
CREATE INDEX llm_usage_request_idx ON llm_usage (request_id);
CREATE INDEX llm_usage_document_idx ON llm_usage (document_id);

-- Daily rollups (pre-aggregated for fast dashboard queries)
CREATE TABLE llm_usage_daily (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Grouping (user_id NULL = global stats)
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  date DATE NOT NULL,

  -- Aggregates
  total_operations INTEGER NOT NULL,
  total_input_tokens BIGINT NOT NULL,
  total_output_tokens BIGINT NOT NULL,
  total_cost_usd DECIMAL(12,6) NOT NULL,

  -- Breakdown by operation/model (JSONB for flexibility)
  operation_breakdown JSONB,
  model_breakdown JSONB,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE(user_id, date)
);

-- Indexes for dashboard queries
CREATE INDEX llm_usage_daily_date_idx ON llm_usage_daily (date);
CREATE INDEX llm_usage_daily_user_idx ON llm_usage_daily (user_id);
CREATE UNIQUE INDEX llm_usage_daily_unique ON llm_usage_daily (user_id, date);

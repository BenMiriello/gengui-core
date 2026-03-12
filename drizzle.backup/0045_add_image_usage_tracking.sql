CREATE TABLE image_usage (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  media_id UUID REFERENCES media(id) ON DELETE SET NULL,
  provider VARCHAR(50) NOT NULL,
  cost_usd DECIMAL(12, 6) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_image_usage_user_id ON image_usage(user_id);
CREATE INDEX idx_image_usage_created_at ON image_usage(created_at);

CREATE TABLE image_usage_daily (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  date DATE NOT NULL,
  total_operations INTEGER NOT NULL,
  total_cost_usd DECIMAL(12, 6) NOT NULL,
  provider_breakdown JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_id, date)
);

CREATE INDEX idx_image_usage_daily_user_date ON image_usage_daily(user_id, date);
CREATE INDEX idx_image_usage_daily_date ON image_usage_daily(date);

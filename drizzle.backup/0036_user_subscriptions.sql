CREATE TYPE user_tier AS ENUM ('free', 'pro', 'max', 'admin');
CREATE TYPE grant_type AS ENUM ('standard', 'test_grant', 'trial_approved', 'paid');

CREATE TABLE user_subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tier user_tier NOT NULL DEFAULT 'free',
  grant_type grant_type NOT NULL DEFAULT 'standard',
  usage_quota INTEGER NOT NULL,
  usage_consumed INTEGER NOT NULL DEFAULT 0,
  period_start TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  period_end TIMESTAMPTZ NOT NULL,
  trial_requested_at TIMESTAMPTZ,
  trial_approved_at TIMESTAMPTZ,
  trial_approved_by UUID REFERENCES users(id),
  cancelled_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_id),
  CONSTRAINT positive_quota CHECK (usage_quota > 0),
  CONSTRAINT valid_consumption CHECK (usage_consumed >= 0),
  CONSTRAINT valid_period CHECK (period_end > period_start)
);

CREATE INDEX idx_user_subscriptions_user ON user_subscriptions(user_id);
CREATE INDEX idx_user_subscriptions_period_end ON user_subscriptions(period_end)
  WHERE cancelled_at IS NULL;
CREATE INDEX idx_user_subscriptions_tier ON user_subscriptions(tier);

CREATE OR REPLACE FUNCTION set_initial_period_end()
RETURNS TRIGGER AS $$
BEGIN
  NEW.period_start := date_trunc('hour', NEW.period_start) + INTERVAL '1 hour';
  NEW.period_end := NEW.period_start + INTERVAL '1 month';
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_set_initial_period_end
  BEFORE INSERT ON user_subscriptions
  FOR EACH ROW
  EXECUTE FUNCTION set_initial_period_end();

-- Migration: Quota Reservations System
-- Created: 2026-02-27
-- Purpose: Track in-flight operations to prevent concurrent quota overruns

CREATE TABLE quota_reservations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  operation_id UUID NOT NULL UNIQUE,
  amount INTEGER NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '5 minutes',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_quota_reservations_user_active
  ON quota_reservations(user_id, expires_at);

CREATE INDEX idx_quota_reservations_expires
  ON quota_reservations(expires_at);

CREATE OR REPLACE FUNCTION cleanup_expired_reservations()
RETURNS INTEGER AS $$
DECLARE
  deleted_count INTEGER;
BEGIN
  DELETE FROM quota_reservations WHERE expires_at < NOW();
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END;
$$ LANGUAGE plpgsql;

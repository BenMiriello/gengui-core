-- Add Google Drive OAuth token storage to users table
-- Tokens are encrypted at rest using AES-256-GCM

ALTER TABLE users
ADD COLUMN google_access_token TEXT,
ADD COLUMN google_refresh_token TEXT,
ADD COLUMN google_token_expiry TIMESTAMPTZ,
ADD COLUMN google_token_iv VARCHAR(32),
ADD COLUMN google_token_tag VARCHAR(32);

COMMENT ON COLUMN users.google_access_token IS 'Encrypted Google OAuth access token';
COMMENT ON COLUMN users.google_refresh_token IS 'Encrypted Google OAuth refresh token';
COMMENT ON COLUMN users.google_token_expiry IS 'When the access token expires';
COMMENT ON COLUMN users.google_token_iv IS 'AES-GCM initialization vector (hex)';
COMMENT ON COLUMN users.google_token_tag IS 'AES-GCM authentication tag (hex)';

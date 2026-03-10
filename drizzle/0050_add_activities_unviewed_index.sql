-- Partial index for querying unviewed activities by user
-- Used by unviewed count queries that filter on viewedAt IS NULL
-- Note: Removed CONCURRENTLY to allow running inside transaction
-- For large tables in production, consider running manually with CONCURRENTLY
CREATE INDEX IF NOT EXISTS idx_activities_unviewed
ON activities (user_id)
WHERE viewed_at IS NULL;

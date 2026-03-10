-- Partial index for querying unviewed activities by user
-- Used by unviewed count queries that filter on viewedAt IS NULL
CREATE INDEX CONCURRENTLY idx_activities_unviewed
ON activities (user_id)
WHERE viewed_at IS NULL;

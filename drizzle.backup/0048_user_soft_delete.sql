-- Add soft delete columns to users table
ALTER TABLE users ADD COLUMN deleted_at TIMESTAMP WITH TIME ZONE;
ALTER TABLE users ADD COLUMN scheduled_deletion_at TIMESTAMP WITH TIME ZONE;

-- Index for efficiently finding users pending permanent deletion
CREATE INDEX users_scheduled_deletion_idx ON users(scheduled_deletion_at)
  WHERE scheduled_deletion_at IS NOT NULL;

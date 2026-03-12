-- Create jobs table for unified background job processing
-- Replaces Redis streams + advisory locks + DB status fields

CREATE TYPE job_status AS ENUM (
  'queued',      -- Waiting to be picked up
  'processing',  -- Worker has claimed it
  'paused',      -- User requested pause (resumable)
  'completed',   -- Successfully finished
  'failed',      -- Error occurred (may retry)
  'cancelled'    -- User cancelled (terminal)
);

CREATE TYPE job_type AS ENUM (
  'document_analysis',
  'prompt_augmentation',
  'thumbnail_generation',
  'media_status_update'
);

CREATE TABLE jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type job_type NOT NULL,
  status job_status NOT NULL DEFAULT 'queued',

  -- Ownership
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  -- Target (polymorphic: document_id, media_id, etc.)
  target_type VARCHAR(30) NOT NULL,
  target_id UUID NOT NULL,

  -- Job-specific payload
  payload JSONB NOT NULL DEFAULT '{}',

  -- Progress tracking
  progress JSONB,
  progress_updated_at TIMESTAMPTZ,
  checkpoint JSONB,

  -- Timing
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,

  -- Error handling
  error_message TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0,
  max_retries INTEGER NOT NULL DEFAULT 3,

  -- Worker identity (for debugging, not for locking)
  worker_id VARCHAR(100)
);

-- Prevent duplicate active jobs for same target
-- Only one job per (type, target_id) can be in an active state
CREATE UNIQUE INDEX idx_jobs_active ON jobs(type, target_id)
  WHERE status IN ('queued', 'processing', 'paused');

-- Queue polling: find next job to process
CREATE INDEX idx_jobs_queue ON jobs(type, status, created_at)
  WHERE status IN ('queued', 'paused');

-- Target lookup: find jobs for a specific document/media
CREATE INDEX idx_jobs_target ON jobs(target_type, target_id);

-- User job history
CREATE INDEX idx_jobs_user ON jobs(user_id, created_at DESC);

-- Stale job detection: find processing jobs that may have crashed
CREATE INDEX idx_jobs_stale ON jobs(status, started_at, progress_updated_at)
  WHERE status = 'processing';

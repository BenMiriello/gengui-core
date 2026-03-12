-- Activities table: presentation layer for tracking user-facing background operations
-- Serves as read model over jobs/media for progress & alerts UI

CREATE TYPE activity_type AS ENUM (
  'image_generation',
  'document_analysis',
  'pdf_export',
  'docx_export',
  'txt_export',
  'md_export'
);

CREATE TYPE activity_status AS ENUM (
  'pending',
  'running',
  'completed',
  'failed',
  'cancelled'
);

CREATE TABLE activities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  activity_type activity_type NOT NULL,
  status activity_status NOT NULL DEFAULT 'pending',
  target_type VARCHAR(30) NOT NULL,
  target_id UUID NOT NULL,
  job_id UUID REFERENCES jobs(id) ON DELETE SET NULL,
  media_id UUID REFERENCES media(id) ON DELETE SET NULL,
  title VARCHAR(255) NOT NULL,
  progress JSONB,
  result_url VARCHAR(512),
  error_message TEXT,
  viewed_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW() NOT NULL,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW() NOT NULL
);

-- Primary query: user's recent activities sorted by time
CREATE INDEX idx_activities_user ON activities(user_id, created_at DESC);

-- Active activities query for progress indicator
CREATE INDEX idx_activities_user_active ON activities(user_id, status)
  WHERE status IN ('pending', 'running');

-- Lookup by job for updates
CREATE INDEX idx_activities_job ON activities(job_id) WHERE job_id IS NOT NULL;

-- Lookup by media for image generation updates
CREATE INDEX idx_activities_media ON activities(media_id) WHERE media_id IS NOT NULL;

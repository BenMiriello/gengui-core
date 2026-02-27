CREATE TYPE submission_type AS ENUM ('contact', 'trial_request', 'bug_report', 'feedback');
CREATE TYPE submission_status AS ENUM ('pending', 'responded', 'resolved');

CREATE TABLE contact_submissions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  email VARCHAR(255) NOT NULL,
  subject VARCHAR(255) NOT NULL,
  message TEXT NOT NULL,
  submission_type submission_type NOT NULL DEFAULT 'contact',
  status submission_status NOT NULL DEFAULT 'pending',
  responded_at TIMESTAMPTZ,
  responded_by UUID REFERENCES users(id),
  admin_notes TEXT,
  user_agent TEXT,
  ip_address VARCHAR(45),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_contact_submissions_status ON contact_submissions(status, created_at DESC);
CREATE INDEX idx_contact_submissions_user ON contact_submissions(user_id);
CREATE INDEX idx_contact_submissions_type ON contact_submissions(submission_type);

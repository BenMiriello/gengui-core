CREATE TABLE pricing_audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  change_type VARCHAR(50) NOT NULL,
  entity_type VARCHAR(50) NOT NULL,
  entity_id VARCHAR(100) NOT NULL,
  old_value JSONB,
  new_value JSONB NOT NULL,
  changed_by UUID NOT NULL REFERENCES users(id),
  reason TEXT NOT NULL,
  git_commit VARCHAR(40),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_pricing_audit_log_date ON pricing_audit_log(created_at DESC);
CREATE INDEX idx_pricing_audit_log_entity ON pricing_audit_log(entity_type, entity_id);
CREATE INDEX idx_pricing_audit_log_changed_by ON pricing_audit_log(changed_by);

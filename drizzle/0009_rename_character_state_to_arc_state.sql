-- Rename character_state to arc_state in change_log
UPDATE change_log SET target_type = 'arc_state' WHERE target_type = 'character_state';
ALTER TABLE change_log DROP CONSTRAINT valid_target_type;
ALTER TABLE change_log ADD CONSTRAINT valid_target_type CHECK (
  target_type IN ('entity', 'facet', 'edge', 'mention', 'arc_state', 'arc', 'thread')
);

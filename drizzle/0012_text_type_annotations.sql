CREATE TABLE text_type_annotations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    segment_id TEXT NOT NULL,
    text_type TEXT NOT NULL,
    relative_start INT NOT NULL,
    relative_end INT NOT NULL,
    boundary_text TEXT NOT NULL DEFAULT '',
    text_hash VARCHAR(64) NOT NULL,
    confidence REAL,
    run_id UUID,
    version_number INT NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_text_type_doc ON text_type_annotations(document_id);
CREATE INDEX idx_text_type_segment ON text_type_annotations(document_id, segment_id);

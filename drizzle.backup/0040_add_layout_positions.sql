-- Store PCA layout positions directly in document
ALTER TABLE documents
ADD COLUMN layout_positions JSONB;

COMMENT ON COLUMN documents.layout_positions IS
  'Cached 2D projection coordinates for graph visualization. NULL means needs recomputation.';

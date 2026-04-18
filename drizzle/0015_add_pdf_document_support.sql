ALTER TABLE documents ADD COLUMN document_type VARCHAR(20) NOT NULL DEFAULT 'text';
ALTER TABLE documents ADD COLUMN file_key TEXT;
ALTER TABLE documents ADD COLUMN page_count INTEGER;

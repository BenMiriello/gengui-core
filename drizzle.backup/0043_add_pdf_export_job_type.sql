-- Add 'pdf_export' to job_type enum
ALTER TYPE job_type ADD VALUE IF NOT EXISTS 'pdf_export';

-- Add image_generation job type to the jobs table enum
ALTER TYPE job_type ADD VALUE IF NOT EXISTS 'image_generation';

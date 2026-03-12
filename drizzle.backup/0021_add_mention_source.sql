-- Add source column to mentions table
DO $$ BEGIN
    CREATE TYPE "public"."mention_source" AS ENUM('extraction', 'name_match', 'coreference', 'semantic');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

ALTER TABLE "mentions" ADD COLUMN "source" "mention_source" DEFAULT 'extraction' NOT NULL;
CREATE INDEX "mentions_source_idx" ON "mentions" USING btree ("source");

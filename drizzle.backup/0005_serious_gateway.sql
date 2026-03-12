CREATE TABLE "document_media" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"document_id" uuid NOT NULL,
	"media_id" uuid NOT NULL,
	"version_id" uuid NOT NULL,
	"start_char" integer,
	"end_char" integer,
	"source_text" text,
	"requested_prompt" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp
);
--> statement-breakpoint
ALTER TABLE "media" ADD COLUMN "s3_key_thumb" varchar(512);--> statement-breakpoint
ALTER TABLE "document_media" ADD CONSTRAINT "document_media_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_media" ADD CONSTRAINT "document_media_media_id_media_id_fk" FOREIGN KEY ("media_id") REFERENCES "public"."media"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_media" ADD CONSTRAINT "document_media_version_id_document_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."document_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "document_media_document_id_idx" ON "document_media" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX "document_media_media_id_idx" ON "document_media" USING btree ("media_id");--> statement-breakpoint
CREATE INDEX "document_media_version_id_idx" ON "document_media" USING btree ("version_id");--> statement-breakpoint
CREATE INDEX "document_media_document_active_idx" ON "document_media" USING btree ("document_id") WHERE deleted_at IS NULL;
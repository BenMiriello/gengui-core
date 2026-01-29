CREATE TABLE "document_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"document_id" uuid NOT NULL,
	"version_number" integer NOT NULL,
	"yjs_state" text NOT NULL,
	"content" text NOT NULL,
	"content_json" jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mentions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"node_id" varchar(255) NOT NULL,
	"document_id" uuid NOT NULL,
	"segment_id" varchar(255) NOT NULL,
	"relative_start" integer NOT NULL,
	"relative_end" integer NOT NULL,
	"original_text" text NOT NULL,
	"text_hash" varchar(64) NOT NULL,
	"confidence" integer DEFAULT 100 NOT NULL,
	"version_number" integer NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "current_version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "segment_sequence" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "yjs_state" text;--> statement-breakpoint
ALTER TABLE "document_versions" ADD CONSTRAINT "document_versions_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mentions" ADD CONSTRAINT "mentions_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "document_versions_unique" ON "document_versions" USING btree ("document_id","version_number");--> statement-breakpoint
CREATE INDEX "document_versions_lookup_idx" ON "document_versions" USING btree ("document_id","version_number");--> statement-breakpoint
CREATE INDEX "mentions_node_idx" ON "mentions" USING btree ("node_id");--> statement-breakpoint
CREATE INDEX "mentions_segment_idx" ON "mentions" USING btree ("document_id","segment_id");--> statement-breakpoint
CREATE INDEX "mentions_version_idx" ON "mentions" USING btree ("document_id","version_number");--> statement-breakpoint
CREATE INDEX "mentions_confidence_idx" ON "mentions" USING btree ("confidence");
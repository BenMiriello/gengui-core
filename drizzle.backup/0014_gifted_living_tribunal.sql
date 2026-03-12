CREATE TYPE "public"."story_node_type" AS ENUM('character', 'location', 'event', 'other');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('user', 'admin');--> statement-breakpoint
CREATE TABLE "story_node_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"from_node_id" uuid NOT NULL,
	"to_node_id" uuid NOT NULL,
	"description" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "story_nodes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"type" "story_node_type" NOT NULL,
	"name" varchar(200) NOT NULL,
	"description" text,
	"passages" jsonb,
	"metadata" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "document_versions" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "document_versions" CASCADE;--> statement-breakpoint
ALTER TABLE "document_media" DROP CONSTRAINT "document_media_version_id_document_versions_id_fk";
--> statement-breakpoint
DROP INDEX "document_media_version_id_idx";--> statement-breakpoint
DROP INDEX "documents_current_version_idx";--> statement-breakpoint
ALTER TABLE "media" ADD COLUMN "attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "media" ADD COLUMN "cancelled_at" timestamp;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "last_activity_at" timestamp;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "ip_address" varchar(45);--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "user_agent" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "role" "user_role" DEFAULT 'user' NOT NULL;--> statement-breakpoint
ALTER TABLE "story_node_connections" ADD CONSTRAINT "story_node_connections_from_node_id_story_nodes_id_fk" FOREIGN KEY ("from_node_id") REFERENCES "public"."story_nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "story_node_connections" ADD CONSTRAINT "story_node_connections_to_node_id_story_nodes_id_fk" FOREIGN KEY ("to_node_id") REFERENCES "public"."story_nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "story_nodes" ADD CONSTRAINT "story_nodes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "story_nodes" ADD CONSTRAINT "story_nodes_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "story_node_connections_from_node_id_idx" ON "story_node_connections" USING btree ("from_node_id");--> statement-breakpoint
CREATE INDEX "story_node_connections_to_node_id_idx" ON "story_node_connections" USING btree ("to_node_id");--> statement-breakpoint
CREATE INDEX "story_nodes_user_id_idx" ON "story_nodes" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "story_nodes_document_id_idx" ON "story_nodes" USING btree ("document_id");--> statement-breakpoint
ALTER TABLE "document_media" DROP COLUMN "version_id";--> statement-breakpoint
ALTER TABLE "documents" DROP COLUMN "version";--> statement-breakpoint
ALTER TABLE "documents" DROP COLUMN "current_version_id";--> statement-breakpoint
DROP TYPE "public"."change_type";--> statement-breakpoint
DROP TYPE "public"."version_format";
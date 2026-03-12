CREATE TYPE "public"."media_status" AS ENUM('queued', 'augmenting', 'processing', 'completed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."model_type" AS ENUM('lora', 'checkpoint', 'other');--> statement-breakpoint
CREATE TYPE "public"."source_type" AS ENUM('upload', 'generation');--> statement-breakpoint
CREATE TYPE "public"."story_node_type" AS ENUM('character', 'location', 'event', 'other');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('user', 'admin');--> statement-breakpoint
CREATE TABLE "document_media" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"document_id" uuid NOT NULL,
	"media_id" uuid NOT NULL,
	"start_char" integer,
	"end_char" integer,
	"node_pos" integer,
	"text_offset" integer,
	"source_text" text,
	"context_before" text,
	"context_after" text,
	"requested_prompt" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"title" varchar(100) NOT NULL,
	"content" text NOT NULL,
	"content_json" jsonb,
	"default_style_preset" varchar(50),
	"default_style_prompt" text,
	"default_image_width" integer DEFAULT 1024,
	"default_image_height" integer DEFAULT 1024,
	"narrative_mode_enabled" boolean DEFAULT false NOT NULL,
	"media_mode_enabled" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "email_verification_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token" varchar(255) NOT NULL,
	"email" varchar(255) NOT NULL,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "email_verification_tokens_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "media" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"source_type" "source_type" DEFAULT 'upload' NOT NULL,
	"status" "media_status" DEFAULT 'completed' NOT NULL,
	"media_role" varchar(20),
	"storage_key" varchar(512),
	"s3_key" varchar(512),
	"s3_key_thumb" varchar(512),
	"s3_bucket" varchar(255),
	"size" integer,
	"mime_type" varchar(100),
	"hash" varchar(64),
	"width" integer,
	"height" integer,
	"prompt" text,
	"style_preset" varchar(50),
	"style_prompt" text,
	"seed" integer,
	"error" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"cancelled_at" timestamp,
	"generated" boolean DEFAULT false NOT NULL,
	"generation_settings" jsonb,
	"generation_settings_schema_version" integer,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "media_tags" (
	"media_id" uuid NOT NULL,
	"tag_id" uuid NOT NULL,
	CONSTRAINT "media_tags_media_id_tag_id_pk" PRIMARY KEY("media_id","tag_id")
);
--> statement-breakpoint
CREATE TABLE "model_inputs" (
	"model_id" uuid NOT NULL,
	"media_id" uuid NOT NULL,
	CONSTRAINT "model_inputs_model_id_media_id_pk" PRIMARY KEY("model_id","media_id")
);
--> statement-breakpoint
CREATE TABLE "models" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" varchar(255) NOT NULL,
	"type" "model_type" NOT NULL,
	"file_path" varchar(512) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "node_media" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"node_id" uuid NOT NULL,
	"media_id" uuid NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "password_reset_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token" varchar(255) NOT NULL,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "password_reset_tokens_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token" varchar(255) NOT NULL,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"last_activity_at" timestamp,
	"ip_address" varchar(45),
	"user_agent" text,
	CONSTRAINT "sessions_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "story_node_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"from_node_id" uuid NOT NULL,
	"to_node_id" uuid NOT NULL,
	"description" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp
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
	"primary_media_id" uuid,
	"style_preset" varchar(50),
	"style_prompt" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "tags" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" varchar(100) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_style_prompts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" varchar(100) NOT NULL,
	"prompt" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"username" varchar(50) NOT NULL,
	"email" varchar(255) NOT NULL,
	"password_hash" varchar(255),
	"oauth_provider" varchar(50),
	"oauth_provider_id" varchar(255),
	"role" "user_role" DEFAULT 'user' NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"pending_email" varchar(255),
	"default_image_width" integer DEFAULT 1024,
	"default_image_height" integer DEFAULT 1024,
	"default_style_preset" varchar(50),
	"hidden_preset_ids" text[],
	"node_type_style_defaults" jsonb,
	"failed_login_attempts" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "users_username_unique" UNIQUE("username"),
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
ALTER TABLE "document_media" ADD CONSTRAINT "document_media_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_media" ADD CONSTRAINT "document_media_media_id_media_id_fk" FOREIGN KEY ("media_id") REFERENCES "public"."media"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_verification_tokens" ADD CONSTRAINT "email_verification_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media" ADD CONSTRAINT "media_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_tags" ADD CONSTRAINT "media_tags_media_id_media_id_fk" FOREIGN KEY ("media_id") REFERENCES "public"."media"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_tags" ADD CONSTRAINT "media_tags_tag_id_tags_id_fk" FOREIGN KEY ("tag_id") REFERENCES "public"."tags"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_inputs" ADD CONSTRAINT "model_inputs_model_id_models_id_fk" FOREIGN KEY ("model_id") REFERENCES "public"."models"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_inputs" ADD CONSTRAINT "model_inputs_media_id_media_id_fk" FOREIGN KEY ("media_id") REFERENCES "public"."media"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "models" ADD CONSTRAINT "models_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "node_media" ADD CONSTRAINT "node_media_node_id_story_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."story_nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "node_media" ADD CONSTRAINT "node_media_media_id_media_id_fk" FOREIGN KEY ("media_id") REFERENCES "public"."media"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "password_reset_tokens" ADD CONSTRAINT "password_reset_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "story_node_connections" ADD CONSTRAINT "story_node_connections_from_node_id_story_nodes_id_fk" FOREIGN KEY ("from_node_id") REFERENCES "public"."story_nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "story_node_connections" ADD CONSTRAINT "story_node_connections_to_node_id_story_nodes_id_fk" FOREIGN KEY ("to_node_id") REFERENCES "public"."story_nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "story_nodes" ADD CONSTRAINT "story_nodes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "story_nodes" ADD CONSTRAINT "story_nodes_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "story_nodes" ADD CONSTRAINT "story_nodes_primary_media_id_media_id_fk" FOREIGN KEY ("primary_media_id") REFERENCES "public"."media"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tags" ADD CONSTRAINT "tags_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_style_prompts" ADD CONSTRAINT "user_style_prompts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "document_media_document_id_idx" ON "document_media" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX "document_media_media_id_idx" ON "document_media" USING btree ("media_id");--> statement-breakpoint
CREATE INDEX "document_media_document_active_idx" ON "document_media" USING btree ("document_id") WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE INDEX "documents_user_id_idx" ON "documents" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "documents_updated_at_idx" ON "documents" USING btree ("updated_at");--> statement-breakpoint
CREATE INDEX "documents_user_active_idx" ON "documents" USING btree ("user_id","deleted_at") WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE INDEX "email_verification_tokens_token_idx" ON "email_verification_tokens" USING btree ("token");--> statement-breakpoint
CREATE INDEX "email_verification_tokens_user_id_idx" ON "email_verification_tokens" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "media_user_id_idx" ON "media" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "media_created_at_idx" ON "media" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "media_hash_idx" ON "media" USING btree ("hash");--> statement-breakpoint
CREATE INDEX "media_source_type_status_idx" ON "media" USING btree ("source_type","status");--> statement-breakpoint
CREATE INDEX "media_user_source_type_idx" ON "media" USING btree ("user_id","source_type");--> statement-breakpoint
CREATE INDEX "media_user_created_idx" ON "media" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "media_role_idx" ON "media" USING btree ("media_role") WHERE media_role IS NOT NULL;--> statement-breakpoint
CREATE INDEX "media_s3_key_thumb_idx" ON "media" USING btree ("s3_key_thumb") WHERE s3_key_thumb IS NOT NULL;--> statement-breakpoint
CREATE INDEX "media_user_hash_active_idx" ON "media" USING btree ("user_id","hash") WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE INDEX "media_user_created_active_idx" ON "media" USING btree ("user_id","created_at") WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "media_user_hash_unique" ON "media" USING btree ("user_id","hash") WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE INDEX "media_tags_tag_id_idx" ON "media_tags" USING btree ("tag_id");--> statement-breakpoint
CREATE INDEX "model_inputs_model_id_idx" ON "model_inputs" USING btree ("model_id");--> statement-breakpoint
CREATE INDEX "models_user_active_idx" ON "models" USING btree ("user_id") WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE INDEX "node_media_node_idx" ON "node_media" USING btree ("node_id") WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE INDEX "node_media_media_idx" ON "node_media" USING btree ("media_id") WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "node_media_unique" ON "node_media" USING btree ("node_id","media_id");--> statement-breakpoint
CREATE INDEX "password_reset_tokens_token_idx" ON "password_reset_tokens" USING btree ("token");--> statement-breakpoint
CREATE INDEX "sessions_token_idx" ON "sessions" USING btree ("token");--> statement-breakpoint
CREATE INDEX "sessions_user_expires_idx" ON "sessions" USING btree ("user_id","expires_at");--> statement-breakpoint
CREATE INDEX "story_node_connections_from_node_id_idx" ON "story_node_connections" USING btree ("from_node_id");--> statement-breakpoint
CREATE INDEX "story_node_connections_to_node_id_idx" ON "story_node_connections" USING btree ("to_node_id");--> statement-breakpoint
CREATE INDEX "story_node_connections_active_idx" ON "story_node_connections" USING btree ("from_node_id","to_node_id") WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE INDEX "story_nodes_user_id_idx" ON "story_nodes" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "story_nodes_document_id_idx" ON "story_nodes" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX "story_nodes_active_idx" ON "story_nodes" USING btree ("document_id","user_id") WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE INDEX "user_style_prompts_user_id_idx" ON "user_style_prompts" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "user_style_prompts_user_active_idx" ON "user_style_prompts" USING btree ("user_id") WHERE deleted_at IS NULL;
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
ALTER TABLE "users" ADD COLUMN "hidden_preset_ids" text[];--> statement-breakpoint
ALTER TABLE "user_style_prompts" ADD CONSTRAINT "user_style_prompts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "user_style_prompts_user_id_idx" ON "user_style_prompts" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "user_style_prompts_user_active_idx" ON "user_style_prompts" USING btree ("user_id") WHERE deleted_at IS NULL;
ALTER TABLE "documents" ADD COLUMN "default_style_preset" varchar(50);--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "default_style_prompt" text;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "default_image_width" integer DEFAULT 1024;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "default_image_height" integer DEFAULT 1024;--> statement-breakpoint
ALTER TABLE "media" ADD COLUMN "style_preset" varchar(50);--> statement-breakpoint
ALTER TABLE "media" ADD COLUMN "style_prompt" text;
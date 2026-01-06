ALTER TABLE "sessions" ADD COLUMN "last_activity_at" timestamp;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "ip_address" varchar(45);--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "user_agent" text;

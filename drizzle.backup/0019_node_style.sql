-- Add style columns to story_nodes (inherit from document, then node-owned)
ALTER TABLE "story_nodes" ADD COLUMN "style_preset" varchar(50);
ALTER TABLE "story_nodes" ADD COLUMN "style_prompt" text;

-- Add node type style defaults to users (per-type default styles)
ALTER TABLE "users" ADD COLUMN "node_type_style_defaults" jsonb;

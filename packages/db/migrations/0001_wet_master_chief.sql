ALTER TABLE "poem" ADD COLUMN "upstream_id" varchar(64);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "poem_upstream_idx" ON "poem" USING btree ("upstream_id");
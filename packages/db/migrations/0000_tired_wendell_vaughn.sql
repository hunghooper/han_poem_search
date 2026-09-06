CREATE TABLE IF NOT EXISTS "author" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name_display" text NOT NULL,
	"name_match" text NOT NULL,
	"dynasty" varchar(32),
	"birth_year" integer,
	"death_year" integer,
	"bio" text,
	"dataset" varchar(64) NOT NULL,
	"source_file" text NOT NULL,
	"commit_sha" varchar(40) NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ingest_run" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"commit_sha" varchar(40) NOT NULL,
	"collections" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"poem_count" integer DEFAULT 0 NOT NULL,
	"line_count" integer DEFAULT 0 NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "poem" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"work_id" uuid NOT NULL,
	"edition" varchar(64) NOT NULL,
	"title_display" text,
	"title_match" text,
	"rhythmic" varchar(64),
	"text_display" text NOT NULL,
	"text_trad" text NOT NULL,
	"text_simp" text NOT NULL,
	"text_match" text NOT NULL,
	"char_count" integer NOT NULL,
	"line_count" integer NOT NULL,
	"dataset" varchar(64) NOT NULL,
	"source_file" text NOT NULL,
	"commit_sha" varchar(40) NOT NULL,
	"content_hash" varchar(64) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "poem_line" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"poem_id" uuid NOT NULL,
	"work_id" uuid NOT NULL,
	"line_no" smallint NOT NULL,
	"text_display" text NOT NULL,
	"text_match" text NOT NULL,
	"char_count" smallint NOT NULL,
	"rhyme_char" varchar(8),
	"tone_pattern" varchar(32)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "search_event" (
	"event_id" uuid PRIMARY KEY NOT NULL,
	"run_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"ts" timestamp with time zone DEFAULT now() NOT NULL,
	"step" varchar(32) NOT NULL,
	"source" varchar(32) NOT NULL,
	"phase" varchar(16) NOT NULL,
	"status" varchar(32),
	"flags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"agent_iteration" integer,
	"message" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "search_result" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"rank" integer NOT NULL,
	"evidence" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "search_run" (
	"id" uuid PRIMARY KEY NOT NULL,
	"query" text NOT NULL,
	"normalized_query" text,
	"intent" varchar(32),
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"final_status" varchar(32),
	"final_confidence" real,
	"final_flags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"final_answer" text,
	"total_cost_usd" real DEFAULT 0 NOT NULL,
	"agent_invoked" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "tool_call" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"agent_iteration" integer NOT NULL,
	"tool_name" varchar(64) NOT NULL,
	"source" varchar(32) NOT NULL,
	"status" varchar(32) NOT NULL,
	"latency_ms" integer NOT NULL,
	"result_count" integer DEFAULT 0 NOT NULL,
	"args" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error_code" varchar(64),
	"error_message" text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "work" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"work_key" varchar(64) NOT NULL,
	"title" text,
	"author_id" uuid,
	"dynasty" varchar(32),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "poem" ADD CONSTRAINT "poem_work_id_work_id_fk" FOREIGN KEY ("work_id") REFERENCES "public"."work"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "poem_line" ADD CONSTRAINT "poem_line_poem_id_poem_id_fk" FOREIGN KEY ("poem_id") REFERENCES "public"."poem"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "poem_line" ADD CONSTRAINT "poem_line_work_id_work_id_fk" FOREIGN KEY ("work_id") REFERENCES "public"."work"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "search_event" ADD CONSTRAINT "search_event_run_id_search_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."search_run"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "search_result" ADD CONSTRAINT "search_result_run_id_search_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."search_run"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "tool_call" ADD CONSTRAINT "tool_call_run_id_search_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."search_run"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "work" ADD CONSTRAINT "work_author_id_author_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."author"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "author_name_match_idx" ON "author" USING btree ("name_match");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "poem_content_hash_idx" ON "poem" USING btree ("content_hash");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "poem_work_idx" ON "poem" USING btree ("work_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "poem_edition_idx" ON "poem" USING btree ("edition");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "poem_line_poem_no_idx" ON "poem_line" USING btree ("poem_id","line_no");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "poem_line_work_idx" ON "poem_line" USING btree ("work_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "poem_line_char_count_idx" ON "poem_line" USING btree ("char_count");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "search_event_run_seq_idx" ON "search_event" USING btree ("run_id","seq");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "search_event_metadata_idx" ON "search_event" USING gin ("metadata");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "search_result_run_rank_idx" ON "search_result" USING btree ("run_id","rank");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "work_work_key_idx" ON "work" USING btree ("work_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "work_author_idx" ON "work" USING btree ("author_id");
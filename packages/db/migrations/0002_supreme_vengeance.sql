CREATE TABLE IF NOT EXISTS "batch_job" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"filename" text NOT NULL,
	"kind" varchar(8) NOT NULL,
	"data_path" text NOT NULL,
	"headers" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"query_column" text,
	"total_rows" integer DEFAULT 0 NOT NULL,
	"agent_enabled" boolean DEFAULT false NOT NULL,
	"agent_cap_usd" real,
	"status" varchar(16) DEFAULT 'scanned' NOT NULL,
	"rows_done" integer DEFAULT 0 NOT NULL,
	"cost_usd" real DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"error" text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "batch_row" (
	"job_id" uuid NOT NULL,
	"row_index" integer NOT NULL,
	"run_id" uuid,
	"status" varchar(32) NOT NULL,
	"result" jsonb,
	"cost_usd" real DEFAULT 0 NOT NULL,
	"finished_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "batch_row_job_id_row_index_pk" PRIMARY KEY("job_id","row_index")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "batch_row" ADD CONSTRAINT "batch_row_job_id_batch_job_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."batch_job"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

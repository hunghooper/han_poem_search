CREATE TABLE IF NOT EXISTS "corpus_addition" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"poem_id" uuid,
	"origin" varchar(16) NOT NULL,
	"status" varchar(16) DEFAULT 'pending' NOT NULL,
	"payload" jsonb NOT NULL,
	"run_id" uuid,
	"submitted_by" text,
	"source_url" text,
	"note" text,
	"review_note" text,
	"reviewed_at" timestamp with time zone,
	"reviewed_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "corpus_addition" ADD CONSTRAINT "corpus_addition_poem_id_poem_id_fk" FOREIGN KEY ("poem_id") REFERENCES "public"."poem"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "corpus_addition_status_idx" ON "corpus_addition" USING btree ("status","created_at");
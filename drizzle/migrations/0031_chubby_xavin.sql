CREATE TABLE "quiz_scaffold_cards" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"from_language_code" text NOT NULL,
	"to_language_code" text NOT NULL,
	"lemma" text NOT NULL,
	"lemma_normalized" text NOT NULL,
	"translation" text NOT NULL,
	"pos" text,
	"note" text,
	"source_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "quiz_scaffold_runs" (
	"from_language_code" text NOT NULL,
	"to_language_code" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"requested_count" integer NOT NULL,
	"written" integer,
	"error" text,
	"cost_usd" numeric(10, 6),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "quiz_scaffold_runs_from_language_code_to_language_code_pk" PRIMARY KEY("from_language_code","to_language_code"),
	CONSTRAINT "quiz_scaffold_runs_status_check" CHECK ("quiz_scaffold_runs"."status" IN ('pending', 'ok', 'failed', 'budget'))
);
--> statement-breakpoint
ALTER TABLE "quiz_scaffold_cards" ADD CONSTRAINT "quiz_scaffold_cards_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "quiz_scaffold_cards_pair_lemma_idx" ON "quiz_scaffold_cards" USING btree ("from_language_code","to_language_code","lemma_normalized");--> statement-breakpoint
CREATE INDEX "quiz_scaffold_cards_pair_idx" ON "quiz_scaffold_cards" USING btree ("from_language_code","to_language_code");
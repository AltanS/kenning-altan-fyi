CREATE TABLE "explanations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"from_language_code" text NOT NULL,
	"to_language_code" text NOT NULL,
	"question" text NOT NULL,
	"question_normalized" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"answer" jsonb,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"prompt_version" integer NOT NULL,
	"cost_usd" numeric(10, 6),
	"latency_ms" integer,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "explanations_status_check" CHECK (status in ('pending', 'ok', 'failed', 'budget'))
);
--> statement-breakpoint
ALTER TABLE "explanations" ADD CONSTRAINT "explanations_from_language_code_languages_code_fk" FOREIGN KEY ("from_language_code") REFERENCES "public"."languages"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "explanations" ADD CONSTRAINT "explanations_to_language_code_languages_code_fk" FOREIGN KEY ("to_language_code") REFERENCES "public"."languages"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "explanations_latest_idx" ON "explanations" USING btree ("from_language_code","to_language_code","question_normalized","created_at" DESC NULLS LAST);
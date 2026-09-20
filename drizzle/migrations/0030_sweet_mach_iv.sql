CREATE TABLE "retranslation_log" (
	"headword_id" uuid NOT NULL,
	"from_language_code" text NOT NULL,
	"to_language_code" text NOT NULL,
	"last_queued_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "retranslation_log_headword_id_from_language_code_to_language_code_pk" PRIMARY KEY("headword_id","from_language_code","to_language_code")
);
--> statement-breakpoint
CREATE TABLE "translation_rejection_signals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "translation_rejection_signals_reason_check" CHECK (reason in ('missing', 'wrong', 'register', 'other'))
);
--> statement-breakpoint
CREATE TABLE "translation_rejections" (
	"run_id" uuid NOT NULL,
	"account_id" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "translation_rejections_run_id_account_id_pk" PRIMARY KEY("run_id","account_id")
);
--> statement-breakpoint
ALTER TABLE "retranslation_log" ADD CONSTRAINT "retranslation_log_headword_id_headwords_id_fk" FOREIGN KEY ("headword_id") REFERENCES "public"."headwords"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retranslation_log" ADD CONSTRAINT "retranslation_log_from_language_code_languages_code_fk" FOREIGN KEY ("from_language_code") REFERENCES "public"."languages"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retranslation_log" ADD CONSTRAINT "retranslation_log_to_language_code_languages_code_fk" FOREIGN KEY ("to_language_code") REFERENCES "public"."languages"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "translation_rejection_signals" ADD CONSTRAINT "translation_rejection_signals_run_id_translation_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."translation_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "translation_rejections" ADD CONSTRAINT "translation_rejections_run_id_translation_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."translation_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "translation_rejections" ADD CONSTRAINT "translation_rejections_account_id_users_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "translation_rejection_signals_run_idx" ON "translation_rejection_signals" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "translation_rejections_account_idx" ON "translation_rejections" USING btree ("account_id");
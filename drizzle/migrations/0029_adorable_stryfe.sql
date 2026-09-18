CREATE TABLE "explanation_moderation" (
	"from_language_code" text NOT NULL,
	"to_language_code" text NOT NULL,
	"question_normalized" text NOT NULL,
	"hidden_at" timestamp with time zone DEFAULT now() NOT NULL,
	"hidden_by_user_id" integer,
	"reason" text,
	CONSTRAINT "explanation_moderation_from_language_code_to_language_code_question_normalized_pk" PRIMARY KEY("from_language_code","to_language_code","question_normalized")
);
--> statement-breakpoint
CREATE TABLE "explanation_reports" (
	"id" serial PRIMARY KEY NOT NULL,
	"explanation_id" uuid NOT NULL,
	"account_id" integer NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "explanation_moderation" ADD CONSTRAINT "explanation_moderation_hidden_by_user_id_users_id_fk" FOREIGN KEY ("hidden_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "explanation_reports" ADD CONSTRAINT "explanation_reports_explanation_id_explanations_id_fk" FOREIGN KEY ("explanation_id") REFERENCES "public"."explanations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "explanation_reports" ADD CONSTRAINT "explanation_reports_account_id_users_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "explanation_reports_reader_idx" ON "explanation_reports" USING btree ("explanation_id","account_id");--> statement-breakpoint
CREATE INDEX "explanations_public_listing_idx" ON "explanations" USING btree ("from_language_code","created_at" DESC NULLS LAST) WHERE "status" = 'ok';
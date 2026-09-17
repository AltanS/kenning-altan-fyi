CREATE TABLE "explanation_asks" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"question" text NOT NULL,
	"question_normalized" text NOT NULL,
	"from_language" text NOT NULL,
	"to_language" text NOT NULL,
	"asked_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "explanation_asks" ADD CONSTRAINT "explanation_asks_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "explanation_asks_identity_idx" ON "explanation_asks" USING btree ("user_id","from_language","to_language","question_normalized");--> statement-breakpoint
CREATE INDEX "explanation_asks_user_asked_idx" ON "explanation_asks" USING btree ("user_id","asked_at" DESC NULLS LAST);
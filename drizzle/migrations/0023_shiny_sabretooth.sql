CREATE TABLE "search_history" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"query" text NOT NULL,
	"from_language" text NOT NULL,
	"to_language" text NOT NULL,
	"headword_id" text,
	"translation" text,
	"at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "search_history" ADD CONSTRAINT "search_history_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "search_history_identity_idx" ON "search_history" USING btree ("user_id","query","from_language","to_language");--> statement-breakpoint
CREATE INDEX "search_history_user_at_idx" ON "search_history" USING btree ("user_id","at" DESC NULLS LAST);
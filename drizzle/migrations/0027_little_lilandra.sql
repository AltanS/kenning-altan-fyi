CREATE TABLE "explanation_authorship" (
	"explanation_id" uuid PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"listed" boolean DEFAULT true NOT NULL,
	"show_name" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "explanation_authorship" ADD CONSTRAINT "explanation_authorship_explanation_id_explanations_id_fk" FOREIGN KEY ("explanation_id") REFERENCES "public"."explanations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "explanation_authorship" ADD CONSTRAINT "explanation_authorship_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "explanation_authorship_user_idx" ON "explanation_authorship" USING btree ("user_id");
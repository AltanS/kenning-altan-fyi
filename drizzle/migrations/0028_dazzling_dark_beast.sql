CREATE TABLE "explanation_votes" (
	"explanation_id" uuid NOT NULL,
	"account_id" integer NOT NULL,
	"value" smallint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "explanation_votes_explanation_id_account_id_pk" PRIMARY KEY("explanation_id","account_id"),
	CONSTRAINT "explanation_votes_value_check" CHECK (value in (-1, 1))
);
--> statement-breakpoint
ALTER TABLE "explanation_votes" ADD CONSTRAINT "explanation_votes_explanation_id_explanations_id_fk" FOREIGN KEY ("explanation_id") REFERENCES "public"."explanations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "explanation_votes" ADD CONSTRAINT "explanation_votes_account_id_users_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "explanation_votes_account_idx" ON "explanation_votes" USING btree ("account_id");
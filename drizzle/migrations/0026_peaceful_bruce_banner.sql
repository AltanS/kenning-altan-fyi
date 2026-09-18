CREATE TABLE "user_profiles" (
	"user_id" integer PRIMARY KEY NOT NULL,
	"public_name" text,
	"public_name_folded" text,
	"hide_new_explanations_by_default" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "user_profiles" ADD CONSTRAINT "user_profiles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "user_profiles_public_name_folded_idx" ON "user_profiles" USING btree ("public_name_folded");
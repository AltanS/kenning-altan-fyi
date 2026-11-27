CREATE TABLE "room_build_days" (
	"user_id" integer NOT NULL,
	"day" date NOT NULL,
	"builds" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "room_build_days_user_id_day_pk" PRIMARY KEY("user_id","day")
);
--> statement-breakpoint
CREATE TABLE "rooms" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" integer NOT NULL,
	"topic" text NOT NULL,
	"topic_normalized" text NOT NULL,
	"term_language_code" text NOT NULL,
	"gloss_language_code" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"stage" text,
	"attempt" integer DEFAULT 1 NOT NULL,
	"build_day" date NOT NULL,
	"content" jsonb,
	"checked_count" integer,
	"removed_count" integer,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"prompt_version" integer NOT NULL,
	"cost_usd" numeric(10, 6),
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "rooms_status_check" CHECK (status in ('pending', 'ok', 'failed', 'budget')),
	CONSTRAINT "rooms_stage_check" CHECK (stage is null or stage in ('writing', 'checking')),
	CONSTRAINT "rooms_languages_differ_check" CHECK (term_language_code <> gloss_language_code)
);
--> statement-breakpoint
ALTER TABLE "room_build_days" ADD CONSTRAINT "room_build_days_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rooms" ADD CONSTRAINT "rooms_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rooms" ADD CONSTRAINT "rooms_term_language_code_languages_code_fk" FOREIGN KEY ("term_language_code") REFERENCES "public"."languages"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rooms" ADD CONSTRAINT "rooms_gloss_language_code_languages_code_fk" FOREIGN KEY ("gloss_language_code") REFERENCES "public"."languages"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "rooms_identity_idx" ON "rooms" USING btree ("user_id","topic_normalized","term_language_code","gloss_language_code");--> statement-breakpoint
CREATE INDEX "rooms_user_created_idx" ON "rooms" USING btree ("user_id","created_at" DESC NULLS LAST);
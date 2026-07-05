CREATE TABLE IF NOT EXISTS "flowlet"."parked_actions" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"subject" text NOT NULL,
	"automation_id" text NOT NULL,
	"run_id" text NOT NULL,
	"resolution" text,
	"requested_at" timestamp with time zone NOT NULL,
	"record" jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "flowlet"."automation_runs" ADD COLUMN "parked_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "parked_actions_scope_idx" ON "flowlet"."parked_actions" USING btree ("tenant_id","subject","automation_id","run_id");
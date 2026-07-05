CREATE SCHEMA IF NOT EXISTS "flowlet";
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "flowlet"."automation_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"automation_id" text NOT NULL,
	"tenant_id" text NOT NULL,
	"subject" text NOT NULL,
	"version" integer NOT NULL,
	"manifest_hash" text,
	"status" text NOT NULL,
	"outcome" text,
	"trigger" jsonb NOT NULL,
	"steps" jsonb NOT NULL,
	"pending_approval" jsonb,
	"error" text,
	"is_test" boolean NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "flowlet"."automation_versions" (
	"automation_id" text NOT NULL,
	"version" integer NOT NULL,
	"spec" jsonb NOT NULL,
	"dsl_version" integer NOT NULL,
	"manifest_hash" text,
	"grants" jsonb NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "automation_versions_automation_id_version_pk" PRIMARY KEY("automation_id","version")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "flowlet"."automations" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"subject" text NOT NULL,
	"name" text NOT NULL,
	"status" text NOT NULL,
	"disabled_reason" text,
	"spec" jsonb NOT NULL,
	"current_version" integer NOT NULL,
	"trigger_kind" text NOT NULL,
	"trigger_key" text,
	"counters" jsonb NOT NULL,
	"created_from_thread_id" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "flowlet"."connections" (
	"toolkit" text NOT NULL,
	"tenant_id" text NOT NULL,
	"subject" text NOT NULL,
	"connected_account_id" text,
	"status" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "connections_tenant_id_subject_toolkit_pk" PRIMARY KEY("tenant_id","subject","toolkit")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "flowlet"."decisions" (
	"tenant_id" text NOT NULL,
	"subject" text NOT NULL,
	"canonical_key" text NOT NULL,
	"decision" jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "decisions_tenant_id_subject_canonical_key_pk" PRIMARY KEY("tenant_id","subject","canonical_key")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "flowlet"."meta" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "flowlet"."saved_flowlets" (
	"id" text NOT NULL,
	"tenant_id" text NOT NULL,
	"subject" text NOT NULL,
	"record" jsonb NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "saved_flowlets_tenant_id_subject_id_pk" PRIMARY KEY("tenant_id","subject","id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "flowlet"."thread_messages" (
	"row_id" bigserial PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"subject" text NOT NULL,
	"thread_id" text NOT NULL,
	"message_id" text NOT NULL,
	"seq" integer NOT NULL,
	"message" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "flowlet"."threads" (
	"id" text NOT NULL,
	"tenant_id" text NOT NULL,
	"subject" text NOT NULL,
	"title" text,
	"next_seq" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "threads_tenant_id_subject_id_pk" PRIMARY KEY("tenant_id","subject","id")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "runs_automation_idx" ON "flowlet"."automation_runs" USING btree ("automation_id","tenant_id","subject");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "automations_scope_idx" ON "flowlet"."automations" USING btree ("tenant_id","subject");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "automations_trigger_idx" ON "flowlet"."automations" USING btree ("trigger_kind","trigger_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "connections_account_idx" ON "flowlet"."connections" USING btree ("connected_account_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "thread_messages_id_uq" ON "flowlet"."thread_messages" USING btree ("tenant_id","subject","thread_id","message_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "thread_messages_seq_uq" ON "flowlet"."thread_messages" USING btree ("tenant_id","subject","thread_id","seq");
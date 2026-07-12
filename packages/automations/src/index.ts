/** @vendoai/automations — apps that run on triggers while the user is away
 * (docs/contracts/07-automations.md).
 *
 * The package root exports exactly the 07 §1 public API plus the zod schemas
 * the conventions require for every persisted shape (00-overview conventions).
 * Depends on core + apps only (the one chain); agentic runs go through the
 * core `AgentRunner` seam — this package never imports the agent.
 */
import { VendoError } from "@vendoai/core";
import type {
  AgentRunner,
  ApprovalRequest,
  AppDocument,
  AppId,
  Guard,
  IsoDateTime,
  Json,
  Principal,
  RunContext,
  RunId,
  StoreAdapter,
  ToolOutcome,
  ToolRegistry,
  TriggerSource,
} from "@vendoai/core";
import type { AppsRuntime } from "@vendoai/apps";
import { z } from "zod";

/** 07 §1 — createAutomations config. */
export interface AutomationsConfig {
  apps: AppsRuntime;
  /** ALREADY guard-bound by the umbrella (05 §2). */
  tools: ToolRegistry;
  /** Core seam: run audit events + approval resumption (onApprovalDecision). */
  guard: Guard;
  store: StoreAdapter;
  /** Absent → agentic runs unavailable, steps still work. */
  runner?: AgentRunner;
  /** Testability. */
  now?: () => Date;
}

/** 07 §5 */
export type RunStatus = "running" | "ok" | "error" | "stopped" | "pending-approval";

/** 07 §5 */
export interface RunRecord {
  id: RunId;
  appId: AppId;
  trigger: { kind: TriggerSource["kind"]; event?: string };
  status: RunStatus;
  startedAt: IsoDateTime;
  finishedAt?: IsoDateTime;
  /** Agentic runs: the report's toolCalls. */
  steps: Array<{ id: string; tool: string; outcome: ToolOutcome["status"]; at: IsoDateTime; detail?: string }>;
  /** Agentic: model-written; steps: generated. */
  summary?: string;
  error?: { code: string; message: string };
}

/** 07 §5 */
export interface RunPlan {
  steps: Array<{ id: string; tool: string; wouldAsk: boolean }>;
  grantsMissing: string[];
}

/** 07 §1 */
export interface AutomationsEngine {
  /** Arm/disarm an app's trigger. Enabling runs the grant-capture flow (07 §3). */
  enable(appId: AppId, ctx: RunContext): Promise<{ enabled: boolean; missing: ApprovalRequest[] }>;
  disable(appId: AppId, ctx: RunContext): Promise<void>;
  /** The user's apps with a trigger. */
  list(ctx: RunContext): Promise<Array<{ app: AppDocument; enabled: boolean }>>;

  // trigger ingestion — three kinds
  /** Schedules: call on a timer or from a serverless cron. */
  tick(now?: Date): Promise<RunId[]>;
  /** Convenience auto-timer around tick (long-lived hosts). */
  start(intervalMs?: number): () => void;
  /** Host product events — THE host seam (vendo.emit). */
  emit(event: string, payload: Json, principal: Principal): Promise<RunId[]>;
  /** External events (Composio/webhooks), mounted by the umbrella. */
  webhook(req: Request): Promise<Response>;

  runs: {
    get(id: RunId, ctx: RunContext): Promise<RunRecord | null>;
    list(
      filter: { appId?: AppId; status?: RunStatus; cursor?: string },
      ctx: RunContext,
    ): Promise<{ runs: RunRecord[]; cursor?: string }>;
    /** Kill switch: best-effort cancel, marks "stopped". */
    stop(id: RunId, ctx: RunContext): Promise<void>;
  };
  /** Preview: what would run, nothing executes. */
  dryRun(appId: AppId, ctx: RunContext, event?: Json): Promise<RunPlan>;
}

export const runStatusSchema = z.enum(["running", "ok", "error", "stopped", "pending-approval"]);

export const runRecordSchema = z.object({
  id: z.string(),
  appId: z.string(),
  trigger: z.object({
    kind: z.enum(["schedule", "host-event", "external"]),
    event: z.string().optional(),
  }),
  status: runStatusSchema,
  startedAt: z.string(),
  finishedAt: z.string().optional(),
  steps: z.array(
    z.object({
      id: z.string(),
      tool: z.string(),
      outcome: z.enum(["ok", "error", "pending-approval", "blocked"]),
      at: z.string(),
      detail: z.string().optional(),
    }),
  ),
  summary: z.string().optional(),
  error: z.object({ code: z.string(), message: z.string() }).optional(),
});

export const runPlanSchema = z.object({
  steps: z.array(z.object({ id: z.string(), tool: z.string(), wouldAsk: z.boolean() })),
  grantsMissing: z.array(z.string()),
});

/** 07 §1 — the engine. Implementation lands with the wave-4 build. */
export function createAutomations(_config: AutomationsConfig): AutomationsEngine {
  throw new VendoError("not-implemented", "@vendoai/automations is being built in wave 4");
}

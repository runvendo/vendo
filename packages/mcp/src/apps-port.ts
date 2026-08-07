import type { AppDocument, AppId, Json, RunContext, UIPayload } from "@vendoai/core";

/** 10-mcp §4 — structural subset of AppsRuntime (06 §1); the umbrella passes
 * `vendo.apps` essentially verbatim. */
export interface AppsPort {
  list(ctx: RunContext): Promise<AppDocument[]>;
  open(
    appId: AppId,
    ctx: RunContext,
  ): Promise<{ kind: "tree"; payload: UIPayload } | { kind: "http"; url: string }>;
  /** guard-bound inside apps */
  call(appId: AppId, ref: string, args: Json, ctx: RunContext): Promise<unknown>;
}

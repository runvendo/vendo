import type { RunStatus } from "@vendoai/automations";
import { VendoError } from "@vendoai/core";
import { json, route, string, type RouteEntry } from "./shared.js";

/** 07-automations / 09 §3 — the /automations wire area. */
export const automationRoutes: RouteEntry[] = [
  route("GET", "/automations", async ({ deps, context }) => {
    return json(await deps.automations.list(await context("automation")));
  }),
  // Grouped like the old if-chain arm (`segments.length === 3 && POST`):
  // context resolves before the operation check, and an unknown operation
  // falls through to the table's not-found.
  route("POST", "/automations/:appId/:op", async ({ deps, context, params, segments }) => {
    const appId = string(params["appId"], "app id");
    const ctx = await context("automation");
    if (segments[2] === "enable") return json(await deps.automations.enable(appId, ctx));
    if (segments[2] === "disable") {
      await deps.automations.disable(appId, ctx);
      return json({});
    }
    if (segments[2] === "dry-run") return json(await deps.automations.dryRun(appId, ctx));
    return undefined;
  }),
];

/** 07-automations / 09 §3 — the /runs wire area. */
export const runRoutes: RouteEntry[] = [
  route("GET", "/runs", async ({ url, deps, context }) => {
    const status = url.searchParams.get("status") ?? undefined;
    const allowed: RunStatus[] = ["running", "ok", "error", "stopped", "pending-approval"];
    if (status !== undefined && !allowed.includes(status as RunStatus)) {
      throw new VendoError("validation", "run status is invalid");
    }
    const filter = {
      ...(url.searchParams.get("appId") === null ? {} : { appId: url.searchParams.get("appId")! }),
      ...(status === undefined ? {} : { status: status as RunStatus }),
      ...(url.searchParams.get("cursor") === null ? {} : { cursor: url.searchParams.get("cursor")! }),
    };
    return json(await deps.automations.runs.list(filter, await context("automation")));
  }),
  // Grouped like the old `head === "runs" && segments.length >= 2` arm: ANY
  // method/depth resolves context first; unmatched shapes fall through.
  route("*", "/runs/:runId/*", async ({ request, deps, context, params, segments }) => {
    const ctx = await context("automation");
    const runId = string(params["runId"], "run id");
    if (request.method === "GET" && segments.length === 2) {
      const run = await deps.automations.runs.get(runId, ctx);
      if (run === null) throw new VendoError("not-found", `run not found: ${runId}`);
      return json(run);
    }
    if (request.method === "POST" && segments[2] === "stop" && segments.length === 3) {
      await deps.automations.runs.stop(runId, ctx);
      return json({});
    }
    return undefined;
  }),
];

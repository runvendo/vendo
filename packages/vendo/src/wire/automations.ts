import type { RunStatus } from "@vendoai/automations";
import { DEFAULT_TRIGGER_ID, VendoError } from "@vendoai/core";
import { json, route, string, type RouteEntry } from "./shared.js";

/** 07-automations / 09 §3 — the /automations wire area. */
export const automationRoutes: RouteEntry[] = [
  route("GET", "/automations", async ({ deps, context }) => {
    return json(await deps.automations.list(await context("automation")));
  }),
  // The trigger id rides a trailing rest segment (the same optional-trailing
  // shape the /runs/:runId/* route below uses), so a caller that names no
  // trigger gets the legacy single-trigger app's id. Context resolves before
  // the operation check, and an unknown operation (or a deeper path) falls
  // through to the table's not-found.
  route("POST", "/automations/:appId/:op/*", async ({ deps, context, params, segments }) => {
    if (segments.length > 4) return undefined;
    const appId = string(params["appId"], "app id");
    const triggerId = segments[3] ?? DEFAULT_TRIGGER_ID;
    const ctx = await context("automation");
    const operation = params["op"];
    if (operation === "enable") return json(await deps.automations.enable(appId, triggerId, ctx));
    if (operation === "disable") {
      await deps.automations.disable(appId, triggerId, ctx);
      return json({});
    }
    if (operation === "dry-run") return json(await deps.automations.dryRun(appId, triggerId, ctx));
    return undefined;
  }),
];

/** 07-automations / 09 §3 — the /runs wire area. */
export const runRoutes: RouteEntry[] = [
  route("GET", "/runs", async ({ url, deps, context }) => {
    const status = url.searchParams.get("status") ?? undefined;
    const allowed: RunStatus[] = ["running", "ok", "error", "stopped"];
    if (status !== undefined && !allowed.includes(status as RunStatus)) {
      throw new VendoError("validation", "run status is invalid");
    }
    const filter = {
      ...(url.searchParams.get("appId") === null ? {} : { appId: url.searchParams.get("appId")! }),
      ...(url.searchParams.get("triggerId") === null ? {} : { triggerId: url.searchParams.get("triggerId")! }),
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
    // The remedy behind a fail-loud run: a FRESH run of the same trigger on the
    // same event, so the door hands back the new run's id.
    if (request.method === "POST" && segments[2] === "rerun" && segments.length === 3) {
      return json({ runId: await deps.automations.runs.rerun(runId, ctx) });
    }
    return undefined;
  }),
];
